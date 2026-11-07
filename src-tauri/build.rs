fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "save_download",
            "clipboard_write",
            "open_external",
            "quit_app",
        ]),
    ))
    .expect("desktop configuration could not be built");
}
