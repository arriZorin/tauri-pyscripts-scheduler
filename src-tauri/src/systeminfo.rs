//! SystemInfo runtime-check primitives (Tauri commands).
//!
//! Privileged I/O for the runtime requirement cascade:
//! - `run_process` — run a process with args, capture output, timeout kill
//! - `find_all_in_path` — filesystem PATH scan (no console-tool spawns; the
//!   repo learned `where.exe` from a GUI process costs seconds of console-host
//!   latency in release builds, see `resolve_interpreter_path` in lib.rs)
//! - `query_python_registry` — HKCU/HKLM `PythonCore` InstallPath keys
//! - `download_to_file` / `extract_zip` — portable-zip bootstrap support
//! - `default_uv_install_dir` — `%LOCALAPPDATA%\\Programs\\uv`

use serde::Serialize;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessResult {
    pub exit_code: i32,
    pub standard_output: String,
    pub standard_error: String,
}

/// Runs `file_name` with `args`, capturing stdout/stderr, killing the process
/// if it exceeds `timeout_ms` (default 5 minutes).
pub fn run_process_impl(
    file_name: &str,
    args: &[String],
    timeout_ms: Option<u64>,
) -> Result<ProcessResult, String> {
    let mut cmd = Command::new(file_name);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW — prevents console windows from flashing when a GUI
        // app (Tauri) spawns console processes (e.g. python --version probes).
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start process '{file_name}': {e}"))?;

    // Take the streams before waiting so we can drain them concurrently.
    let mut stdout = child.stdout.take().expect("stdout is piped");
    let mut stderr = child.stderr.take().expect("stderr is piped");

    // Drain both streams on worker threads so full buffers never deadlock.
    let stdout_handle = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stdout.read_to_string(&mut buf);
        buf
    });
    let stderr_handle = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf);
        buf
    });

    let effective_timeout = Duration::from_millis(timeout_ms.unwrap_or(5 * 60 * 1000));
    let start = std::time::Instant::now();
    let exit_code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(-1),
            Ok(None) => {
                if start.elapsed() >= effective_timeout {
                    let _ = child.kill();
                    return Err(format!(
                        "process '{file_name}' exceeded timeout of {effective_timeout:?}"
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                let _ = child.kill();
                return Err(format!("failed to wait for process '{file_name}': {e}"));
            }
        }
    };

    let stdout = stdout_handle.join().unwrap_or_default();
    let stderr = stderr_handle.join().unwrap_or_default();
    Ok(ProcessResult {
        exit_code,
        standard_output: stdout,
        standard_error: stderr,
    })
}

/// Returns every existing `<entry>\<name>.exe` across PATH-style entries.
pub fn find_all_in_path(name: &str, entries: &[String]) -> Vec<String> {
    let exe_name = if name.to_lowercase().ends_with(".exe") {
        name.to_string()
    } else {
        format!("{name}.exe")
    };
    let mut found = Vec::new();
    for entry in entries {
        if entry.is_empty() {
            continue;
        }
        let candidate = Path::new(entry).join(&exe_name);
        if candidate.is_file() {
            found.push(candidate.to_string_lossy().to_string());
        }
    }
    found
}

/// Builds `%LOCALAPPDATA%\Programs\uv` from the given LocalAppData root.
pub fn default_uv_install_dir_impl(local_app_data: &str) -> String {
    Path::new(local_app_data)
        .join("Programs")
        .join("uv")
        .to_string_lossy()
        .to_string()
}

/// Returns python.exe paths from the Windows registry (HKCU then HKLM).
#[cfg(windows)]
pub fn query_python_registry_impl() -> Vec<String> {
    use winreg::enums::*;
    use winreg::RegKey;

    let mut paths = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let root = RegKey::predef(hive);
        let Ok(cores) = root.open_subkey(r"SOFTWARE\Python\PythonCore") else {
            continue;
        };
        for version in cores.enum_keys().flatten() {
            let Ok(install_key) = cores.open_subkey(format!(r"{version}\InstallPath")) else {
                continue;
            };
            let Ok(install_dir) = install_key.get_value::<String, _>("") else {
                continue;
            };
            let python_exe = Path::new(&install_dir).join("python.exe");
            let path = python_exe.to_string_lossy().to_string();
            if seen.insert(path.clone()) {
                paths.push(path);
            }
        }
    }
    paths
}

#[cfg(not(windows))]
pub fn query_python_registry_impl() -> Vec<String> {
    Vec::new()
}

/// Downloads `url` (following redirects) to `dest_path`.
pub fn download_to_file_impl(url: &str, dest_path: &str) -> Result<(), String> {
    let response = ureq::get(url)
        .timeout(Duration::from_secs(120))
        .call()
        .map_err(|e| format!("download failed: {e}"))?;
    let mut reader = response.into_reader();
    let mut file = std::fs::File::create(dest_path)
        .map_err(|e| format!("failed to create '{dest_path}': {e}"))?;
    std::io::copy(&mut reader, &mut file)
        .map_err(|e| format!("failed to write '{dest_path}': {e}"))?;
    Ok(())
}

/// Extracts a zip archive into `dest_dir`, skipping traversal/absolute entries.
pub fn extract_zip_impl(zip_path: &str, dest_dir: &str) -> Result<(), String> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| format!("failed to open '{zip_path}': {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("invalid zip '{zip_path}': {e}"))?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("failed to read zip entry {index}: {e}"))?;
        // Reject absolute paths and `..` traversal before touching the disk.
        let Some(relative) = entry.enclosed_name() else {
            continue;
        };
        let dest = Path::new(dest_dir).join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&dest)
                .map_err(|e| format!("failed to create dir '{}': {e}", dest.display()))?;
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create dir '{}': {e}", parent.display()))?;
        }
        let mut out = std::fs::File::create(&dest)
            .map_err(|e| format!("failed to create '{}': {e}", dest.display()))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| format!("failed to extract '{}': {e}", dest.display()))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn run_process(
    file_name: String,
    args: Vec<String>,
    timeout_ms: Option<u64>,
) -> Result<ProcessResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_process_impl(&file_name, &args, timeout_ms))
        .await
        .map_err(|e| format!("run_process task panicked: {e}"))?
}

#[tauri::command]
pub fn find_all_in_path_command(name: String) -> Result<Vec<String>, String> {
    if name.is_empty() {
        return Err("name cannot be empty".to_string());
    }
    let entries: Vec<String> = std::env::var("PATH")
        .unwrap_or_default()
        .split(';')
        .map(str::to_string)
        .collect();
    Ok(find_all_in_path(&name, &entries))
}

#[tauri::command]
pub fn query_python_registry() -> Vec<String> {
    query_python_registry_impl()
}

#[tauri::command]
pub fn default_uv_install_dir() -> Result<String, String> {
    let local_app_data = std::env::var("LOCALAPPDATA")
        .map_err(|_| "LOCALAPPDATA is not set".to_string())?;
    Ok(default_uv_install_dir_impl(&local_app_data))
}

#[tauri::command]
pub async fn download_to_file(url: String, dest_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || download_to_file_impl(&url, &dest_path))
        .await
        .map_err(|e| format!("download_to_file task panicked: {e}"))?
}

#[tauri::command]
pub async fn extract_zip(zip_path: String, dest_dir: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || extract_zip_impl(&zip_path, &dest_dir))
        .await
        .map_err(|e| format!("extract_zip task panicked: {e}"))?
}

#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    if path.is_empty() {
        return Err("path cannot be empty".to_string());
    }
    std::fs::remove_file(&path).map_err(|e| format!("failed to delete '{path}': {e}"))
}

#[tauri::command]
pub fn get_disk_free_space(path: String) -> Result<u64, String> {
    if path.is_empty() {
        return Err("path cannot be empty".to_string());
    }
    #[cfg(windows)]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use std::mem::MaybeUninit;
        use winapi::um::fileapi::GetDiskFreeSpaceExW;
        use winapi::um::winnt::ULARGE_INTEGER;

        let wide_path: Vec<u16> = OsStr::new(&path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        unsafe {
            let mut free_bytes: ULARGE_INTEGER = MaybeUninit::zeroed().assume_init();
            let ret = GetDiskFreeSpaceExW(
                wide_path.as_ptr(),
                &mut free_bytes as *mut ULARGE_INTEGER,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            );
            if ret == 0 {
                return Err("failed to query disk free space".to_string());
            }
            Ok(*free_bytes.QuadPart())
        }
    }
    #[cfg(not(windows))]
    {
        // Fallback: use the `statvfs` approach via path
        let p = std::path::Path::new(&path);
        // Try to get the mount point ancestor
        let mount = if p.is_dir() { p } else { p.parent().unwrap_or(p) };
        #[cfg(target_os = "linux")]
        {
            use std::mem::MaybeUninit;
            use std::ffi::CString;
            let cpath = CString::new(mount.to_string_lossy().as_ref()).map_err(|_| "invalid path".to_string())?;
            let mut stat: libc::statvfs = unsafe { MaybeUninit::zeroed().assume_init() };
            let ret = unsafe { libc::statvfs(cpath.as_ptr(), &mut stat) };
            if ret != 0 {
                return Err("failed to query disk free space".to_string());
            }
            Ok(stat.f_frsize as u64 * stat.f_bavail as u64)
        }
        #[cfg(not(target_os = "linux"))]
        {
            Err("disk free space not supported on this platform".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use std::path::PathBuf;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "systeminfo_test_{}_{}",
            std::process::id(),
            label
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn run_process_returns_output_and_exit_code() {
        let result = run_process_impl("cmd.exe", &["/c".to_string(), "echo hello".to_string()], None)
            .expect("should run");
        assert_eq!(result.exit_code, 0);
        assert!(result.standard_output.contains("hello"));
    }

    #[test]
    fn run_process_reports_nonzero_exit_code() {
        let result = run_process_impl("cmd.exe", &["/c".to_string(), "exit 42".to_string()], None)
            .expect("should run");
        assert_eq!(result.exit_code, 42);
    }

    #[test]
    fn process_result_serializes_to_frontend_contract_names() {
        // The TS ProcessResult contract reads exitCode/standardOutput/standardError;
        // serde field renames must keep the wire format aligned or every field is
        // `undefined` in JS (regression: "Cannot read properties of undefined (reading 'trim')").
        let result = ProcessResult {
            exit_code: 0,
            standard_output: "out".to_string(),
            standard_error: "err".to_string(),
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["exitCode"], 0);
        assert_eq!(json["standardOutput"], "out");
        assert_eq!(json["standardError"], "err");
        assert!(json.get("exit_code").is_none());
        assert!(json.get("stdout").is_none());
    }

    #[test]
    fn run_process_kills_on_timeout() {
        let start = std::time::Instant::now();
        let result = run_process_impl(
            "cmd.exe",
            &["/c".to_string(), "ping -n 10 127.0.0.1".to_string()],
            Some(500),
        );
        assert!(result.is_err());
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn find_all_in_path_returns_existing_matches_in_order() {
        let dir_a = temp_dir("path_a");
        let dir_b = temp_dir("path_b");
        fs::write(dir_a.join("python.exe"), "stub").unwrap();
        fs::write(dir_b.join("python.exe"), "stub").unwrap();
        fs::write(dir_b.join("other.exe"), "stub").unwrap();

        let entries = vec![
            dir_a.to_string_lossy().to_string(),
            dir_b.to_string_lossy().to_string(),
        ];
        let found = find_all_in_path("python", &entries);

        assert_eq!(found.len(), 2);
        assert!(found[0].ends_with("python.exe"));
        assert_eq!(found[0], dir_a.join("python.exe").to_string_lossy().to_string());
        let _ = fs::remove_dir_all(&dir_a);
        let _ = fs::remove_dir_all(&dir_b);
    }

    #[test]
    fn find_all_in_path_skips_missing() {
        let dir = temp_dir("path_missing");
        let entries = vec![dir.to_string_lossy().to_string()];
        assert!(find_all_in_path("python", &entries).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn default_uv_install_dir_builds_expected_path() {
        let dir = default_uv_install_dir_impl(r"C:\Users\me\AppData\Local");
        assert!(dir.ends_with(r"Programs\uv") || dir.ends_with("Programs/uv"));
        assert!(dir.starts_with(r"C:\Users\me\AppData\Local"));
    }

    #[test]
    fn extract_zip_writes_entries_under_dest_dir() {
        let src = temp_dir("zip_src");
        let dest = temp_dir("zip_dest");
        let zip_path = src.join("sample.zip");
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            writer.start_file("uv.exe", options).unwrap();
            writer.write_all(b"stub-binary").unwrap();
            writer.finish().unwrap();
        }

        extract_zip_impl(&zip_path.to_string_lossy(), &dest.to_string_lossy()).unwrap();

        let extracted = dest.join("uv.exe");
        assert!(extracted.is_file());
        assert_eq!(fs::read_to_string(&extracted).unwrap(), "stub-binary");
        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dest);
    }

    #[test]
    fn extract_zip_skips_traversal_entries() {
        let src = temp_dir("zip_traversal");
        let dest = temp_dir("zip_traversal_dest");
        let outside = src.join("evil.txt");
        let zip_path = src.join("evil.zip");
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            writer.start_file("../evil.txt", options).unwrap();
            writer.write_all(b"pwned").unwrap();
            writer.finish().unwrap();
        }

        extract_zip_impl(&zip_path.to_string_lossy(), &dest.to_string_lossy()).unwrap();

        assert!(!outside.exists());
        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dest);
    }
}
