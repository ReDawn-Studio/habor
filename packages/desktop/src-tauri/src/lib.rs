use serde::Serialize;
use std::sync::Mutex;
use tauri::{menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder}, tray::TrayIconBuilder, Manager, State};

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

pub fn run() {
    tauri::Builder::default()
        .manage(RuntimeState::default())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![desktop_info, runtime_status, set_runtime_status])
        .setup(|app| {
            let new_task = MenuItemBuilder::with_id("new-task", "New Task").build(app)?;
            let command_palette = MenuItemBuilder::with_id("command-palette", "Command Palette").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit habor").build(app)?;
            let file_menu = SubmenuBuilder::new(app, "File").item(&new_task).separator().item(&quit).build()?;
            let view_menu = SubmenuBuilder::new(app, "View").item(&command_palette).build()?;
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
