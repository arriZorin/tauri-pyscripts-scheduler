// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

mod scheduler;
mod dep_scanner;
mod systeminfo;
mod venv;
#[cfg(windows)]
mod windows_scheduler;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

fn app_mode(debug: bool) -> &'static str {
    if debug {
        "dev"
    } else {
        "prod"
    }
}

#[tauri::command]
fn get_app_mode() -> String {
    app_mode(cfg!(debug_assertions)).to_string()
}

struct AppDataDir(PathBuf);

fn is_absolute_windows_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3 && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/')
}

fn log_dir(root: &Path) -> Result<PathBuf, String> {
    let dir = root.join("logs");
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create log directory: {}", e))?;
    Ok(dir)
}

#[tauri::command]
fn get_log_directory(state: tauri::State<'_, AppDataDir>) -> Result<String, String> {
    log_dir(&state.0).map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn scan_files(folder: String) -> Result<Vec<String>, String> {
    let path = Path::new(&folder);
    let mut files: Vec<String> = Vec::new();

    fn walk_dir(dir_path: &PathBuf, files: &mut Vec<String>) -> std::io::Result<()> {
        let mut entries = fs::read_dir(dir_path)?;
        while let Some(Ok(entry)) = entries.next() {
            let path = entry.path();
            if path.is_symlink() {
                continue;
            }
            if path.is_file() {
                let full_path = path.to_string_lossy().to_string();
                files.push(full_path.replace('\\', "/"));
            } else if path.is_dir() {
                // Skip virtual environments — their contents are not scripts.
                if entry.file_name().to_string_lossy() == ".venv" {
                    continue;
                }
                walk_dir(&path, files)?;
            }
        }
        Ok(())
    }

    let result = walk_dir(&path.into(), &mut files);
    if let Err(e) = result {
        return Err(e.to_string());
    }
    files.sort();
    Ok(files)
}

// Pure helper function for reading app files (unit-testable without Tauri state)
fn read_app_file(root: &std::path::Path, rel: &str) -> Result<Option<String>, String> {
    // Validation: empty path
    if rel.is_empty() {
        return Err("path cannot be empty".to_string());
    }
    // Validation: starts with '/'
    if rel.starts_with('/') {
        return Err("absolute paths are not allowed".to_string());
    }
    // Validation: starts with '\\'
    if rel.starts_with('\\') {
        return Err("absolute paths are not allowed".to_string());
    }
    // Validation: starts with "file://"
    if rel.starts_with("file://") {
        return Err("absolute paths are not allowed".to_string());
    }
    // Validation: is_absolute() catches Windows drive paths like D:\x
    if std::path::Path::new(rel).is_absolute() {
        return Err("absolute paths are not allowed".to_string());
    }
    // Validation: path traversal
    if rel.contains("..") {
        return Err("path traversal is not allowed".to_string());
    }

    let full_path = root.join(rel);
    match fs::read_to_string(&full_path) {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("failed to read file: {}", e)),
    }
}

#[tauri::command]
fn read_text_file(
    state: tauri::State<'_, AppDataDir>,
    path: String,
) -> Result<Option<String>, String> {
    read_app_file(&state.0, &path)
}

#[tauri::command]
fn write_text_file(
    state: tauri::State<'_, AppDataDir>,
    path: String,
    content: String,
) -> Result<(), String> {
    if path.is_empty() {
        return Err("path cannot be empty".to_string());
    }
    if path.starts_with('/') || path.starts_with('\\') || path.starts_with("file://") {
        return Err("absolute paths are not allowed".to_string());
    }
    if path.contains("..") {
        return Err("path traversal is not allowed".to_string());
    }

    let full_path = state.0.join(&path);
    if let Some(parent) = full_path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            return Err(format!("failed to create directory: {}", e));
        }
    }
    fs::write(&full_path, &content).map_err(|e| format!("failed to write file: {}", e))
}

#[tauri::command]
fn path_exists(path: String) -> Result<bool, String> {
    if path.is_empty() {
        return Err("path cannot be empty".to_string());
    }
    if !Path::new(&path).is_absolute() && !is_absolute_windows_path(&path) {
        return Err("path must be absolute".to_string());
    }

    Ok(Path::new(&path).is_file())
}

/// Builds the `explorer.exe /select,<path>` argument, normalizing forward
/// slashes to backslashes so Explorer opens the file's folder with the file
/// selected. Rejects empty and non-absolute paths.
fn explorer_select_arg(path: &str) -> Result<String, String> {
    if path.is_empty() {
        return Err("path cannot be empty".to_string());
    }
    if !Path::new(path).is_absolute() && !is_absolute_windows_path(path) {
        return Err("path must be absolute".to_string());
    }
    Ok(format!("/select,{}", path.replace('/', "\\")))
}

#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    let select_arg = explorer_select_arg(&path)?;
    if !Path::new(&path).is_file() {
        return Err("path does not exist".to_string());
    }
    #[cfg(windows)]
    {
        // explorer.exe is a shell command; spawn (don't block) and let it
        // return immediately — the Explorer window is the user feedback.
        std::process::Command::new("explorer.exe")
            .arg(select_arg)
            .spawn()
            .map_err(|e| format!("failed to open explorer: {}", e))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = select_arg;
        Err("reveal in explorer is only supported on Windows".to_string())
    }
}

#[derive(Deserialize)]
struct SchedulePayload {
    schedule_type: String,
    value: String,
    day_of_week: Option<u8>,
    every: Option<u32>,
    unit: Option<String>,
    start_at: Option<String>,
}

fn schedule_from_payload(payload: SchedulePayload) -> Result<scheduler::ScheduleSpec, String> {
    match payload.schedule_type.as_str() {
        "once" => Ok(scheduler::ScheduleSpec::Once {
            run_at: payload.value,
        }),
        "daily" => Ok(scheduler::ScheduleSpec::Daily {
            start_at: payload.start_at.ok_or("start_at is required")?,
        }),
        "weekly" => Ok(scheduler::ScheduleSpec::Weekly {
            start_at: payload.start_at.ok_or("start_at is required")?,
            day_of_week: payload.day_of_week.ok_or("day_of_week is required")?,
        }),
        "interval" => Ok(scheduler::ScheduleSpec::Interval {
            start_at: payload.start_at.ok_or("start_at is required")?,
            every: payload.every.ok_or("every is required")?,
            unit: payload.unit.ok_or("unit is required")?,
        }),
        _ => Err("unsupported schedule type".to_string()),
    }
}

#[tauri::command]
fn create_scheduled_task(
    state: tauri::State<'_, AppDataDir>,
    task_name: String,
    venv_python_path: String,
    script_path: String,
    arguments: Vec<String>,
    working_directory: String,
    log_directory: String,
    schedule: SchedulePayload,
) -> Result<String, String> {
    let schedule = schedule_from_payload(schedule)?;
    #[cfg(windows)]
    {
        // Write the embedded launcher into app data (idempotent) so the task
        // can run the venv interpreter directly instead of through cmd.exe.
        let launcher_path = windows_scheduler::ensure_launcher(&state.0)?
            .to_string_lossy()
            .to_string();
        return windows_scheduler::create_task(&windows_scheduler::CreateTaskSpec {
            task_name,
            venv_python_path,
            launcher_path,
            script_path,
            arguments,
            working_directory,
            log_directory,
            schedule,
        });
    }
    #[cfg(not(windows))]
    {
        let _ = state;
        scheduler::execute_command(scheduler::build_create_command(
            scheduler::CreateScheduledTask {
                task_name,
                venv_python_path,
                script_path,
                arguments,
                working_directory,
                log_directory,
                schedule,
            },
        )?)
    }
}

#[tauri::command]
fn update_scheduled_task(
    state: tauri::State<'_, AppDataDir>,
    task_name: String,
    venv_python_path: String,
    script_path: String,
    arguments: Vec<String>,
    working_directory: String,
    log_directory: String,
    schedule: SchedulePayload,
) -> Result<String, String> {
    let schedule = schedule_from_payload(schedule)?;
    #[cfg(windows)]
    {
        // Same launcher path as create (idempotent write, keeps in sync).
        let launcher_path = windows_scheduler::ensure_launcher(&state.0)?
            .to_string_lossy()
            .to_string();
        // Native registration uses TASK_CREATE_OR_UPDATE, so update is an
        // upsert of the same definition used by create.
        return windows_scheduler::create_task(&windows_scheduler::CreateTaskSpec {
            task_name,
            venv_python_path,
            launcher_path,
            script_path,
            arguments,
            working_directory,
            log_directory,
            schedule,
        });
    }
    #[cfg(not(windows))]
    {
        let _ = state;
        scheduler::execute_command(scheduler::build_update_command(&task_name, &arguments)?)
    }
}

#[tauri::command]
fn delete_scheduled_task(task_name: String) -> Result<String, String> {
    #[cfg(windows)]
    {
        return windows_scheduler::delete_task(&task_name);
    }
    #[cfg(not(windows))]
    scheduler::execute_command(scheduler::build_delete_command(&task_name)?)
}

#[tauri::command]
fn set_scheduled_task_enabled(task_name: String, enabled: bool) -> Result<String, String> {
    #[cfg(windows)]
    {
        return windows_scheduler::set_enabled(&task_name, enabled);
    }
    #[cfg(not(windows))]
    scheduler::execute_command(scheduler::build_set_enabled_command(&task_name, enabled)?)
}

#[tauri::command]
fn run_scheduled_task(task_name: String) -> Result<String, String> {
    #[cfg(windows)]
    {
        return windows_scheduler::run_task(&task_name);
    }
    #[cfg(not(windows))]
    scheduler::execute_command(scheduler::build_run_command(&task_name)?)
}

#[tauri::command]
fn get_scheduled_task_status(task_name: String) -> Result<String, String> {
    #[cfg(windows)]
    {
        return windows_scheduler::task_status(&task_name);
    }
    #[cfg(not(windows))]
    scheduler::execute_command(scheduler::build_status_command(&task_name)?)
}

#[tauri::command]
fn list_scheduled_tasks() -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        return windows_scheduler::list_scheduled_tasks();
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

#[tauri::command]
fn get_task_run_result(
    state: tauri::State<'_, AppDataDir>,
    task_name: String,
) -> Result<windows_scheduler::TaskRunResult, String> {
    #[cfg(windows)]
    {
        let dir = log_dir(&state.0)?;
        return windows_scheduler::task_run_result(&task_name, &dir.to_string_lossy());
    }
    #[cfg(not(windows))]
    {
        let _ = state;
        Err("task run results are only available on Windows".to_string())
    }
}

#[tauri::command]
fn get_venv_python_path(
    dir_path: String,
) -> Result<String, String> {
    let dir = std::path::Path::new(&dir_path);
    if !dir.is_dir() {
        return Err(format!("directory not found: {}", dir_path));
    }
    Ok(venv::venv_python_path(dir)
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
fn ensure_script_venv(
    state: tauri::State<'_, AppDataDir>,
    dir_path: String,
    python_version: String,
) -> Result<String, String> {
    let dir = std::path::Path::new(&dir_path);
    if !dir.is_dir() {
        return Err(format!("directory not found: {}", dir_path));
    }
    if python_version.is_empty() {
        return Err("python_version cannot be empty".to_string());
    }
    // Call into the module; pass None for uv_path so it uses PATH-discovered uv.exe.
    // The caller (venv bootstrap) ensures uv is available before this runs.
    venv::ensure_venv(&state.0, dir, &python_version, None)
}

#[tauri::command]
fn sync_script_deps(
    state: tauri::State<'_, AppDataDir>,
    dir_path: String,
    requirements: Vec<String>,
) -> Result<(), String> {
    let dir = std::path::Path::new(&dir_path);
    if !dir.is_dir() {
        return Err(format!("directory not found: {}", dir_path));
    }
    venv::sync_deps(&state.0, dir, &requirements, None)
}

#[tauri::command]
fn delete_script_venv(
    state: tauri::State<'_, AppDataDir>,
    dir_path: String,
) -> Result<(), String> {
    let dir = std::path::Path::new(&dir_path);
    if !dir.is_dir() {
        return Err(format!("directory not found: {}", dir_path));
    }
    venv::delete_venv(&state.0, dir)
}

#[tauri::command]
fn read_folder_requirements(dir_path: String) -> Result<Vec<String>, String> {
    if dir_path.is_empty() {
        return Err("dir_path cannot be empty".to_string());
    }
    if !std::path::Path::new(&dir_path).is_dir() {
        return Err(format!("directory not found: {}", dir_path));
    }
    venv::read_requirements_txt(&dir_path)
}

#[tauri::command]
fn scan_script_deps(file_path: String) -> Result<Vec<String>, String> {
    if file_path.is_empty() {
        return Err("file_path cannot be empty".to_string());
    }
    dep_scanner::scan_script_deps(&file_path)
}

#[tauri::command]
fn write_requirements_txt(dir_path: String, deps: Vec<String>) -> Result<(), String> {
    if dir_path.is_empty() {
        return Err("dir_path cannot be empty".to_string());
    }
    let dir = std::path::Path::new(&dir_path);
    if !dir.is_dir() {
        return Err(format!("directory not found: {}", dir_path));
    }
    // Validate path safety: no .. traversal, no null bytes
    if dir_path.contains("..") || dir_path.contains('\0') {
        return Err("invalid directory path".to_string());
    }
    let req_path = dir.join("requirements.txt");
    let content = deps.join("\n");
    std::fs::write(&req_path, &content)
        .map_err(|e| format!("failed to write requirements.txt: {}", e))
}

#[tauri::command]
fn uv_sync_project(
    state: tauri::State<'_, AppDataDir>,
    dir_path: String,
    python_version: String,
) -> Result<String, String> {
    let dir = std::path::Path::new(&dir_path);
    if !dir.is_dir() {
        return Err(format!("directory not found: {}", dir_path));
    }
    if python_version.is_empty() {
        return Err("python_version cannot be empty".to_string());
    }
    // Validate path safety
    if dir_path.contains("..") || dir_path.contains('\0') {
        return Err("invalid directory path".to_string());
    }

    venv::sync_project(&state.0, dir, &python_version, None)?;
    // Return venv python path for consistency with ensure_script_venv
    let py_path = venv::venv_python_path(dir);
    Ok(py_path.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            scan_files,
            read_text_file,
            write_text_file,
            path_exists,
            reveal_in_explorer,
            create_scheduled_task,
            update_scheduled_task,
            delete_scheduled_task,
            set_scheduled_task_enabled,
            run_scheduled_task,
            get_scheduled_task_status,
            list_scheduled_tasks,
            get_task_run_result,
            get_log_directory,
            get_app_mode,
            get_venv_python_path,
            ensure_script_venv,
            sync_script_deps,
            delete_script_venv,
            read_folder_requirements,
            scan_script_deps,
            write_requirements_txt,
            uv_sync_project,
            systeminfo::run_process,
            systeminfo::find_all_in_path_command,
            systeminfo::query_python_registry,
            systeminfo::default_uv_install_dir,
            systeminfo::download_to_file,
            systeminfo::extract_zip,
            systeminfo::delete_file,
            systeminfo::get_disk_free_space
        ])
        .setup(|app| {
            let dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(AppDataDir(dir));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use std::env;
    use std::fs;
    use std::path::PathBuf;

    // Helper function to create a unique temp directory per test
    // (cargo runs tests in parallel threads; a shared dir lets one test's
    // remove_dir_all race another test's file writes, so each test gets its own dir)
    fn create_temp_dir(label: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!(
            "read_app_file_test_{}_{}",
            std::process::id(),
            label
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_read_app_file_missing_file_returns_none() {
        let dir = create_temp_dir("missing");
        let result = crate::read_app_file(&dir, "nonexistent.txt");
        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_read_app_file_existing_file_returns_content() {
        let dir = create_temp_dir("existing");
        let path = dir.join("test.txt");
        fs::write(&path, "hello world").unwrap();
        let result = crate::read_app_file(&dir, "test.txt");
        assert!(result.is_ok());
        let content = result.unwrap();
        assert!(content.is_some());
        let content = content.unwrap();
        assert_eq!(content, "hello world");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_read_app_file_empty_path_errs() {
        let dir = env::temp_dir();
        let result = crate::read_app_file(&dir, "");
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "path cannot be empty");
    }

    #[test]
    fn test_read_app_file_absolute_unix_path_errs() {
        let dir = env::temp_dir();
        let result = crate::read_app_file(&dir, "/abs");
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "absolute paths are not allowed");
    }

    #[test]
    fn test_read_app_file_absolute_windows_path_errs() {
        let dir = env::temp_dir();
        let result = crate::read_app_file(&dir, "\\abs");
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "absolute paths are not allowed");
    }

    #[test]
    fn test_read_app_file_file_uri_errs() {
        let dir = env::temp_dir();
        let result = crate::read_app_file(&dir, "file://x");
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "absolute paths are not allowed");
    }

    #[test]
    fn test_read_app_file_path_traversal_errs() {
        let dir = create_temp_dir("traversal");
        let secret_path = dir.join("secret.txt");
        fs::write(&secret_path, "top secret").unwrap();
        let result = crate::read_app_file(&dir, "../secret.txt");
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "path traversal is not allowed");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_read_app_file_path_traversal_windows_errs() {
        let dir = create_temp_dir("traversal_win");
        let secret_path = dir.join("secret.txt");
        fs::write(&secret_path, "top secret").unwrap();
        let result = crate::read_app_file(&dir, "..\\secret.txt");
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "path traversal is not allowed");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_read_app_file_drive_absolute_path_errs() {
        // Test Windows drive absolute path (e.g., C:\Windows\win.ini)
        let dir = env::temp_dir();
        let result = crate::read_app_file(&dir, "C:\\Windows\\win.ini");
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "absolute paths are not allowed");
    }

    #[test]
    fn test_is_absolute_windows_path_true_for_drive_paths() {
        assert!(crate::is_absolute_windows_path("C:\\Python312\\python.exe"));
        assert!(crate::is_absolute_windows_path("D:/tools/python.exe"));
    }

    #[test]
    fn test_is_absolute_windows_path_false_for_relative() {
        assert!(!crate::is_absolute_windows_path("python"));
        assert!(!crate::is_absolute_windows_path(""));
        assert!(!crate::is_absolute_windows_path("scripts/run.py"));
    }

    #[test]
    fn test_path_exists_reports_files_and_missing_paths() {
        let dir = create_temp_dir("path-exists");
        let existing = dir.join("script.py");
        fs::write(&existing, "print('ok')").unwrap();

        assert!(crate::path_exists(existing.to_string_lossy().to_string()).unwrap());
        assert!(!crate::path_exists(dir.join("missing.py").to_string_lossy().to_string()).unwrap());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_path_exists_rejects_empty_and_relative_paths() {
        assert_eq!(
            crate::path_exists("".to_string()).unwrap_err(),
            "path cannot be empty"
        );
        assert_eq!(
            crate::path_exists("scripts/run.py".to_string()).unwrap_err(),
            "path must be absolute"
        );
    }

    #[test]
    fn test_explorer_select_arg_normalizes_forward_slashes() {
        assert_eq!(
            crate::explorer_select_arg("C:/scripts/backup.py").unwrap(),
            "/select,C:\\scripts\\backup.py"
        );
    }

    #[test]
    fn test_explorer_select_arg_keeps_backslashes() {
        assert_eq!(
            crate::explorer_select_arg("C:\\scripts\\backup.py").unwrap(),
            "/select,C:\\scripts\\backup.py"
        );
    }

    #[test]
    fn test_explorer_select_arg_rejects_empty_and_relative_paths() {
        assert_eq!(
            crate::explorer_select_arg("").unwrap_err(),
            "path cannot be empty"
        );
        assert_eq!(
            crate::explorer_select_arg("scripts/run.py").unwrap_err(),
            "path must be absolute"
        );
        assert_eq!(
            crate::explorer_select_arg("python").unwrap_err(),
            "path must be absolute"
        );
    }

    #[test]
    fn test_reveal_in_explorer_rejects_relative_paths() {
        // Only the validation path is tested — the spawn launches a GUI process.
        assert_eq!(
            crate::reveal_in_explorer("scripts/run.py".to_string()).unwrap_err(),
            "path must be absolute"
        );
    }

    #[test]
    fn test_app_mode_reflects_build_profile() {
        assert_eq!(crate::app_mode(true), "dev");
        assert_eq!(crate::app_mode(false), "prod");
    }

    #[test]
    fn test_log_dir_creates_logs_folder() {
        let dir = create_temp_dir("logs");
        let result = crate::log_dir(&dir).unwrap();
        assert_eq!(result, dir.join("logs"));
        assert!(result.is_dir());
        let _ = fs::remove_dir_all(&dir);
    }
}
