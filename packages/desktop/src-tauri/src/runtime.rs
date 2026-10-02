use serde_json::{json, Value};
use std::{collections::HashMap, io::{BufRead, BufReader, Write}, path::PathBuf, process::{Child, ChildStdin, Command, Stdio}, sync::{atomic::{AtomicBool, AtomicU64, Ordering}, mpsc::{channel, Sender}, Arc, Mutex}, time::{Duration, Instant}};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct RuntimeState { server: Mutex<Option<Arc<Server>>> }
struct Server {
    child: Mutex<Child>, input: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<u64, Sender<Value>>>, next: AtomicU64,
    alive: AtomicBool, diagnostics: Mutex<String>,
}
impl Server {
    fn request(&self, method: String, params: Value) -> Result<Value, String> {
        if !self.alive.load(Ordering::SeqCst) { return Err(self.failure()); }
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = channel();
        self.pending.lock().map_err(|e| e.to_string())?.insert(id, sender);
        let message = json!({"id":id,"method":method,"params":params});
        let written = (|| {
            let mut input = self.input.lock().map_err(|e| e.to_string())?;
            let stream = input.as_mut().ok_or("App Server stopped")?;
            writeln!(stream, "{}", message).map_err(|e| e.to_string())
        })();
        if let Err(error) = written { self.pending.lock().unwrap().remove(&id); return Err(error); }
        let response = receiver.recv_timeout(Duration::from_secs(90));
        self.pending.lock().unwrap().remove(&id);
        let response = response.map_err(|_| "App Server request timed out; reconnect to inspect task status".to_string())?;
        if let Some(error) = response.get("error") { return Err(error.as_str().unwrap_or("App Server failed").to_string()); }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }
    fn failure(&self) -> String { format!("App Server stopped. {}", self.diagnostics.lock().map(|s| s.clone()).unwrap_or_default()) }
    fn shutdown(&self) {
        // EOF asks the service to cancel its owned jobs, flush state and close Agents.
        self.input.lock().unwrap().take();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let mut child = self.child.lock().unwrap();
            if child.try_wait().ok().flatten().is_some() { break; }
            if Instant::now() >= deadline {
                #[cfg(windows)]
                { let _ = Command::new("taskkill.exe").args(["/PID", &child.id().to_string(), "/T", "/F"]).output(); }
                let _ = child.kill(); let _ = child.wait(); break;
            }
            drop(child); std::thread::sleep(Duration::from_millis(50));
        }
    }
}
impl RuntimeState {
    fn ensure(&self, app: &AppHandle) -> Result<Arc<Server>, String> {
        let mut slot = self.server.lock().map_err(|e| e.to_string())?;
        if let Some(server) = slot.as_ref() { if server.alive.load(Ordering::SeqCst) { return Ok(server.clone()); } }
        if let Some(old) = slot.take() { old.shutdown(); }
        let runtime = runtime_path(app)?;
        let node = runtime.join(if cfg!(windows) {"node.exe"} else {"node"});
        let script = runtime.join("dist/index.mjs");
        if !node.is_file() || !script.is_file() { return Err("Desktop runtime is missing. Run npm run prepare:runtime before building.".into()); }
        let mut command = Command::new(&node);
        command.arg(&script).current_dir(&runtime).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut paths = vec![runtime.clone()];
        if cfg!(target_os="macos") { paths.extend([PathBuf::from("/opt/homebrew/bin"),PathBuf::from("/usr/local/bin"),PathBuf::from("/usr/bin"),PathBuf::from("/bin")]); }
        if let Some(path) = std::env::var_os("PATH") { paths.extend(std::env::split_paths(&path)); }
        command.env("PATH", std::env::join_paths(paths).map_err(|e|e.to_string())?);
        command.env("HABOR_DSH_ACP_ENTRY",runtime.join("node_modules/@agent-router/dsh-acp/dist/index.js"));
        #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        let mut child = command.spawn().map_err(|e|format!("Cannot start bundled runtime: {e}"))?;
        let input = child.stdin.take(); let output = child.stdout.take().ok_or("No server stdout")?; let errors = child.stderr.take().ok_or("No server stderr")?;
        let server = Arc::new(Server {child:Mutex::new(child),input:Mutex::new(input),pending:Mutex::new(HashMap::new()),next:AtomicU64::new(1),alive:AtomicBool::new(true),diagnostics:Mutex::new(String::new())});
        let reader_server = server.clone(); let handle = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line)=line else {break};
                let Ok(message)=serde_json::from_str::<Value>(&line) else {continue};
                if let Some(id)=message.get("id").and_then(Value::as_u64) { if let Some(sender)=reader_server.pending.lock().unwrap().remove(&id) {let _=sender.send(message);} }
                else if let Some(event)=message.get("event") {let _=handle.emit("habor:server-event",event);}
            }
            reader_server.alive.store(false,Ordering::SeqCst);
            let error=reader_server.failure();
            for (_,sender) in reader_server.pending.lock().unwrap().drain(){let _=sender.send(json!({"error":error}));}
            let _=handle.emit("habor:server-stopped",error);
        });
        let error_server=server.clone();
        std::thread::spawn(move || { for line in BufReader::new(errors).lines().map_while(Result::ok) { let mut log=error_server.diagnostics.lock().unwrap(); log.push_str(&line);log.push('\n'); if log.len()>8000 {*log=log.chars().rev().take(4000).collect::<String>().chars().rev().collect();} } });
        *slot=Some(server.clone());
        // Preserve the workspace selected in the desktop service. The old startup
        // path always called `workspace.open` with the bundle's current directory
        // (usually `/`), which silently moved the task context away from the CLI's
        // workspace on every launch. Only seed a workspace for a fresh install.
        let snapshot = server.request("snapshot".into(), serde_json::json!({}))?;
        let current = snapshot.get("cwd").and_then(Value::as_str).filter(|path| !path.is_empty());
        if current.is_none() {
            let workspace = default_workspace().map_err(|e| e.to_string())?;
            server.request("workspace.open".into(), serde_json::json!({"path": workspace}))?;
        }
        Ok(server)
    }
    pub fn shutdown(&self) { if let Some(server)=self.server.lock().unwrap().take(){server.shutdown();} }
}
fn runtime_path(app:&AppHandle)->Result<PathBuf,String>{
    #[cfg(debug_assertions)]
    { let dev=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime"); if dev.exists(){return Ok(dev);} }
    app.path().resource_dir().map(|p|p.join("runtime")).map_err(|e|e.to_string())
}
fn default_workspace() -> Result<PathBuf, std::io::Error> {
    if let Some(home) = std::env::var_os("HOME") {
        let path = PathBuf::from(home);
        if path.is_dir() { return Ok(path); }
    }
    std::env::current_dir()
}
#[tauri::command]
pub async fn server_request(app:AppHandle, method:String, params:Value)->Result<Value,String>{
    tauri::async_runtime::spawn_blocking(move || {
        let server=app.state::<RuntimeState>().ensure(&app)?;
        server.request(method,params)
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn quit_app(app:AppHandle)->Result<(),String>{
    tauri::async_runtime::spawn_blocking(move || {app.state::<RuntimeState>().shutdown();app.exit(0);}).await.map_err(|e|e.to_string())
}
