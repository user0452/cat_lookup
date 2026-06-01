mod commands;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::load_settings,
            commands::save_settings,
            commands::capture_screen_region,
            commands::ocr_image,
            commands::explain_text,
            commands::simulate_copy,
            commands::get_clipboard_text,
            commands::set_clipboard_text,
            commands::save_clipboard,
            commands::restore_clipboard,
            commands::remember_target_window,
            commands::copy_selected_text,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
