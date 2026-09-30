use serde::Serialize;
use std::sync::Mutex;
use tauri::{menu::{MenuBuilder, MenuItemBuilder, MenuItemKind, SubmenuBuilder}, tray::TrayIconBuilder, AppHandle, Manager, State};

#[derive(Default)]
struct RuntimeState {
    sidecar_started: Mutex<bool>,
}

#[derive(Serialize)]
struct DesktopInfo {
    platform: String,
    arch: String,
    sidecar: String,
}

#[tauri::command]
fn desktop_info() -> DesktopInfo {
    DesktopInfo {
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        sidecar: "habor-app-server".to_string(),
    }
}

#[tauri::command]
fn runtime_status(state: State<'_, RuntimeState>) -> bool {
    *state.sidecar_started.lock().expect("runtime state poisoned")
}

#[tauri::command]
fn set_runtime_status(state: State<'_, RuntimeState>, running: bool) -> bool {
    let mut status = state.sidecar_started.lock().expect("runtime state poisoned");
    *status = running;
    *status
}

#[tauri::command]
fn set_menu_language(app: AppHandle, language: String) -> Result<(), String> {
    let labels = match language.as_str() {
        "zh-CN" => ("文件", "新建任务", "命令面板", "退出 habor", "视图"),
        "zh-TW" => ("檔案", "新增任務", "指令面板", "結束 habor", "檢視"),
        "ja" => ("ファイル", "新しいタスク", "コマンドパレット", "habor を終了", "表示"),
        "ko" => ("파일", "새 작업", "명령 팔레트", "habor 종료", "보기"),
        "es" => ("Archivo", "Nueva tarea", "Paleta de comandos", "Salir de habor", "Ver"),
        _ => ("File", "New Task", "Command Palette", "Quit habor", "View"),
    };
    let menu = app.menu().ok_or_else(|| "application menu is unavailable".to_string())?;
    if let Some(MenuItemKind::Submenu(file)) = menu.get("file") {
        file.set_text(labels.0).map_err(|error| error.to_string())?;
    }
    if let Some(MenuItemKind::Submenu(view)) = menu.get("view") {
        view.set_text(labels.4).map_err(|error| error.to_string())?;
    }
    for item in menu.items().map_err(|error| error.to_string())? {
        if let MenuItemKind::MenuItem(item) = item {
            match item.id().as_ref() {
                "new-task" => item.set_text(labels.1),
                "command-palette" => item.set_text(labels.2),
                "quit" => item.set_text(labels.3),
                _ => Ok(()),
            }.map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .manage(RuntimeState::default())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![desktop_info, runtime_status, set_runtime_status, set_menu_language])
        .setup(|app| {
            let new_task = MenuItemBuilder::with_id("new-task", "New Task").build(app)?;
            let command_palette = MenuItemBuilder::with_id("command-palette", "Command Palette").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit habor").build(app)?;
            let file_menu = SubmenuBuilder::with_id(app, "file", "File").item(&new_task).separator().item(&quit).build()?;
            let view_menu = SubmenuBuilder::with_id(app, "view", "View").item(&command_palette).build()?;
            let menu = MenuBuilder::new(app).item(&file_menu).item(&view_menu).build()?;
            app.set_menu(menu.clone())?;
            TrayIconBuilder::with_id("habor-tray").icon(app.default_window_icon().expect("default icon").clone()).menu(&menu).on_menu_event(|app, event| {
                if event.id().as_ref() == "quit" {
                    app.exit(0);
                }
            }).build(app)?;
            let menu_handle = app.menu().expect("menu handle");
            let _ = menu_handle;
            #[cfg(desktop)]
            {
                let window = app.get_webview_window("main").expect("main window missing");
                window.set_title("habor")?;
            }
            let _ = app.handle();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running habor desktop");
}
