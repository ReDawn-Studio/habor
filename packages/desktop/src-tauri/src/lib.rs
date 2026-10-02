mod runtime;
use runtime::{RuntimeState, server_request, quit_app};
use tauri::{menu::{MenuBuilder, MenuItemBuilder, MenuItemKind, SubmenuBuilder}, tray::TrayIconBuilder, AppHandle, Emitter, Manager};

fn show(app:&AppHandle) {if let Some(window)=app.get_webview_window("main"){let _=window.show();let _=window.unminimize();let _=window.set_focus();}}
fn menu_action(app:&AppHandle,id:&str){if id=="quit"{app.state::<RuntimeState>().shutdown();app.exit(0);return;}show(app);let _=app.emit("habor:menu",id);}
#[tauri::command]
fn set_menu_language(app:AppHandle,language:String)->Result<(),String>{
    let labels=match language.as_str(){
        "zh-CN"=>("文件","新建任务","命令面板","退出 habor","视图","显示 habor"),
        "zh-TW"=>("檔案","新增任務","指令面板","結束 habor","檢視","顯示 habor"),
        "ja"=>("ファイル","新しいタスク","コマンドパレット","habor を終了","表示","habor を表示"),
        "ko"=>("파일","새 작업","명령 팔레트","habor 종료","보기","habor 표시"),
        "es"=>("Archivo","Nueva tarea","Paleta de comandos","Salir de habor","Ver","Mostrar habor"),
        _=>("File","New task","Command palette","Quit habor","View","Show habor")};
    let menu=app.menu().ok_or("Menu unavailable")?;
    for item in menu.items().map_err(|e|e.to_string())? {
        if let MenuItemKind::Submenu(sub)=item {
            let label=match sub.id().as_ref(){"file"=>Some(labels.0),"view"=>Some(labels.4),_=>None};
            if let Some(label)=label{sub.set_text(label).map_err(|e|e.to_string())?;}
            for child in sub.items().map_err(|e|e.to_string())? {if let MenuItemKind::MenuItem(child)=child{let label=match child.id().as_ref(){"new-task"=>Some(labels.1),"command-palette"=>Some(labels.2),"quit"=>Some(labels.3),"show"=>Some(labels.5),_=>None};if let Some(label)=label{child.set_text(label).map_err(|e|e.to_string())?;}}}
        }
    }
    Ok(())
}
pub fn run(){
    let app=tauri::Builder::default().manage(RuntimeState::default())
        .invoke_handler(tauri::generate_handler![server_request,quit_app,set_menu_language])
        .setup(|app|{
            let new_task=MenuItemBuilder::with_id("new-task","New task").accelerator("CmdOrCtrl+N").build(app)?;
            let palette=MenuItemBuilder::with_id("command-palette","Command palette").accelerator("CmdOrCtrl+K").build(app)?;
            let quit=MenuItemBuilder::with_id("quit","Quit habor").accelerator("CmdOrCtrl+Q").build(app)?;
            let show=MenuItemBuilder::with_id("show","Show habor").build(app)?;
            let file=SubmenuBuilder::with_id(app,"file","File").item(&new_task).separator().item(&quit).build()?;
            let edit=SubmenuBuilder::new(app,"Edit").undo().redo().separator().cut().copy().paste().select_all().build()?;
            let view=SubmenuBuilder::with_id(app,"view","View").item(&show).item(&palette).build()?;
            let menu=MenuBuilder::new(app).item(&file).item(&edit).item(&view).build()?;app.set_menu(menu.clone())?;
            app.on_menu_event(|app,event|menu_action(app,event.id().as_ref()));
            TrayIconBuilder::with_id("habor-tray").icon(app.default_window_icon().ok_or("Missing app icon")?.clone()).menu(&menu).build(app)?;
            Ok(())
        })
        .on_window_event(|window,event|{if let tauri::WindowEvent::CloseRequested{api,..}=event{api.prevent_close();let _=window.hide();}})
        .build(tauri::generate_context!()).expect("Cannot start habor");
    app.run(|app,event|match event {
        tauri::RunEvent::Exit=>app.state::<RuntimeState>().shutdown(),
        #[cfg(target_os="macos")]
        tauri::RunEvent::Reopen{..}=>show(app),
        _=>{}
    });
}
