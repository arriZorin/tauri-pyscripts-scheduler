//! Virtual environment management for per-folder venvs.
//!
//! Manages per-folder virtual environments via uv. Each directory of scripts
//! shares one venv identified by a SHA256 hash of the directory path.
//!
//! # Idempotency
//! - `ensure_venv`: health check before creating (checks python.exe + pyvenv.cfg + version match)
//! - `sync_deps`: atomic write + backup + hash cache; skip uv pip install if unchanged
//! - `delete_venv`: cleans up venv + all dep files

// Most functions appear unused until later phases wire them. Suppress
// until the full module is consumed.
#![allow(dead_code)]

use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

// ── Folder hash ──────────────────────────────────────────

/// Normalizes a directory path: lowercases drive letter, forward slashes,
/// no trailing slash.
pub fn normalize_path(path: &str) -> String {
    let normalized = path.replace('\\', "/").to_lowercase();
    let trimmed = normalized.trim_end_matches('/').to_string();
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed
    }
}

/// Computes a deterministic short hash for a directory path.
/// Returns first 16 hex chars of SHA256(normalized_absolute_path).
pub fn folder_hash(dir_path: &str) -> String {
    let normalized = normalize_path(dir_path);
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    let result = hasher.finalize();
    hex_encode(&result[..8]) // 8 bytes = 16 hex chars
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ── Path helpers ─────────────────────────────────────────

/// Returns the venv directory inside the script folder: <folder>/.venv
pub fn venv_dir(folder_dir: &Path) -> PathBuf {
    folder_dir.join(".venv")
}

/// Returns the venv's python.exe path.
pub fn venv_python_path(folder_dir: &Path) -> PathBuf {
    venv_dir(folder_dir).join("Scripts").join("python.exe")
}

/// Returns the pyvenv.cfg path for a venv.
pub fn venv_cfg_path(folder_dir: &Path) -> PathBuf {
    venv_dir(folder_dir).join("pyvenv.cfg")
}

/// Returns app-data/deps/<hash>.txt — the combined requirements file.
pub fn deps_file_path(app_data: &Path, folder_hash: &str) -> PathBuf {
    app_data.join("deps").join(format!("{}.txt", folder_hash))
}

/// Returns app-data/deps/<hash>.sha256 — the cached hash of requirements.
pub fn deps_hash_file_path(app_data: &Path, folder_hash: &str) -> PathBuf {
    app_data
        .join("deps")
        .join(format!("{}.sha256", folder_hash))
}

/// Returns app-data/deps/<hash>.txt.bak — backup of previous requirements.
pub fn deps_backup_file_path(app_data: &Path, folder_hash: &str) -> PathBuf {
    app_data
        .join("deps")
        .join(format!("{}.txt.bak", folder_hash))
}

/// Returns app-data/deps/<hash>.txt.tmp — temporary write target.
pub fn deps_tmp_file_path(app_data: &Path, folder_hash: &str) -> PathBuf {
    app_data
        .join("deps")
        .join(format!("{}.txt.tmp", folder_hash))
}

// ── Requirement combinators ──────────────────────────────

/// Combines requirements from multiple scripts: union, sorted, deduplicated.
pub fn combine_requirements(all_requirements: &[Vec<String>]) -> Vec<String> {
    let mut set = BTreeSet::new();
    for reqs in all_requirements {
        for req in reqs {
            if !req.trim().is_empty() {
                set.insert(req.trim().to_string());
            }
        }
    }
    set.into_iter().collect()
}

/// Computes SHA256 hex string of combined requirements joined by newline.
pub fn compute_requirements_hash(requirements: &[String]) -> String {
    let input = requirements.join("\n");
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let result = hasher.finalize();
    hex_encode(&result)
}

/// Returns true if the cached hash matches the computed hash of requirements.
/// Pure — no I/O.
pub fn compute_deps_fresh(cached_hash: &str, requirements: &[String]) -> bool {
    if cached_hash.is_empty() {
        return false;
    }
    let computed = compute_requirements_hash(requirements);
    computed == cached_hash
}

// ── Health check ─────────────────────────────────────────

/// Reads the version key from pyvenv.cfg. Accepts both formats:
///   python -m venv: `version = 3.11.5`
///   uv:            `version_info = 3.11`
/// Returns the major.minor string (e.g. "3.11").
fn read_pyvenv_version(cfg_path: &Path) -> Result<String, String> {
    let content =
        fs::read_to_string(cfg_path).map_err(|e| format!("failed to read pyvenv.cfg: {}", e))?;
    for line in content.lines() {
        let trimmed = line.trim();
        let value = if let Some(v) = trimmed.strip_prefix("version = ") {
            Some(v)
        } else if let Some(v) = trimmed.strip_prefix("version_info = ") {
            Some(v)
        } else {
            None
        };
        if let Some(v) = value {
            let parts: Vec<&str> = v.trim().split('.').collect();
            if parts.len() >= 2 {
                return Ok(format!("{}.{}", parts[0], parts[1]));
            }
        }
    }
    Err("version key not found in pyvenv.cfg".to_string())
}

/// Full health check: verifies (1) python.exe exists,
/// (2) pyvenv.cfg exists, (3) version in pyvenv.cfg matches
/// `python_version`. Returns Ok(path) if healthy.
pub fn check_venv_health(
    folder_dir: &Path,
    python_version: &str,
) -> Result<String, String> {
    let py_path = venv_python_path(folder_dir);
    if !py_path.is_file() {
        return Err(format!(
            "python.exe not found at {}",
            py_path.to_string_lossy()
        ));
    }

    let cfg_path = venv_cfg_path(folder_dir);
    let actual_version = read_pyvenv_version(&cfg_path)?;

    if actual_version != python_version {
        return Err(format!(
            "version mismatch: expected {}, found {}",
            python_version, actual_version
        ));
    }

    Ok(py_path.to_string_lossy().to_string())
}

// ── Ensure ───────────────────────────────────────────────

/// Ensures a healthy venv exists in the script folder (<folder>/.venv).
/// Calls check_venv_health first;
/// if healthy → return path (0 subprocess cost).
/// If unhealthy → delete + recreate via `uv venv --python <ver>` and clear
/// the deps hash cache so the fresh venv is not skipped by sync_deps.
///
/// `uv_path` is the path to uv.exe; `None` for testing (no subprocess).
pub fn ensure_venv(
    app_data: &Path,
    folder_dir: &Path,
    python_version: &str,
    uv_path: Option<&str>,
) -> Result<String, String> {
    // Try health check first
    if let Ok(path) = check_venv_health(folder_dir, python_version) {
        return Ok(path);
    }

    // Unhealthy or missing — delete and recreate
    let _ = fs::remove_dir_all(venv_dir(folder_dir));

    // Clear the deps hash cache so sync_deps won't skip the fresh venv
    let folder_hash = folder_hash(&folder_dir.to_string_lossy());
    let _ = fs::remove_file(deps_hash_file_path(app_data, &folder_hash));

    let uv = uv_path.unwrap_or("uv.exe");
    let venv = venv_dir(folder_dir);
    let venv_str = venv.to_string_lossy().to_string();

    // Use run_process pattern: CREATE_NO_WINDOW + spawn + wait
    let output = std::process::Command::new(uv)
        .args(["venv", "--python", python_version, &venv_str])
        .output()
        .map_err(|e| format!("failed to start uv venv: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("uv venv failed: {}", stderr.trim()));
    }

    // Verify post-creation health
    check_venv_health(folder_dir, python_version)
}

// ── Deps sync ────────────────────────────────────────────

/// Builds the uv command that installs the deps file into the venv.
///
/// Uses `uv pip install --requirement <file>` (NOT `uv pip sync`) so that the
/// full dependency graph is resolved and installed. `uv pip sync` installs
/// only the packages listed in the file and never their transitive
/// dependencies (e.g. openpyxl without et-xmlfile), which broke scripts at
/// import time with `ModuleNotFoundError`.
fn build_uv_sync_command(uv: &str, venv_py: &Path, deps_path: &Path) -> std::process::Command {
    let mut cmd = std::process::Command::new(uv);
    cmd.args([
        "pip",
        "install",
        "--requirement",
        &deps_path.to_string_lossy(),
        "--python",
        &venv_py.to_string_lossy(),
        "--quiet",
    ]);
    cmd
}

/// Idempotent dependency sync with atomic write + backup:
///   1. Compute hash of new requirements
///   2. If hash matches cached hash → return Ok (skip)
///   3. Write new requirements to a .tmp file
///   4. Rename existing deps/<hash>.txt → .bak (if exists)
///   5. Rename .tmp → deps/<hash>.txt (atomic rename)
///   6. Run `uv pip install --requirement <venv> <req-file>`
///   7. On success → delete .bak, write new hash file
///   8. On failure → restore .bak → deps/<hash>.txt, return Err
pub fn sync_deps(
    app_data: &Path,
    folder_dir: &Path,
    requirements: &[String],
    uv_path: Option<&str>,
) -> Result<(), String> {
    // 1. Compute hash
    let new_hash = compute_requirements_hash(requirements);
    let folder_hash = folder_hash(&folder_dir.to_string_lossy());

    // 2. Check cached hash — skip if unchanged
    let hash_path = deps_hash_file_path(app_data, &folder_hash);
    if hash_path.is_file() {
        let cached =
            fs::read_to_string(&hash_path).map_err(|e| format!("failed to read hash: {}", e))?;
        if compute_deps_fresh(cached.trim(), requirements) {
            return Ok(());
        }
    }

    let deps_path = deps_file_path(app_data, &folder_hash);
    let tmp_path = deps_tmp_file_path(app_data, &folder_hash);
    let bak_path = deps_backup_file_path(app_data, &folder_hash);

    // Ensure deps directory exists
    if let Some(parent) = deps_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create deps dir: {}", e))?;
    }

    // 3. Write to .tmp
    let content = requirements.join("\n");
    fs::write(&tmp_path, &content).map_err(|e| format!("failed to write temp deps: {}", e))?;

    // 4. Backup existing .txt → .bak
    let had_backup = if deps_path.is_file() {
        fs::rename(&deps_path, &bak_path).map_err(|e| format!("failed to backup deps: {}", e))?;
        true
    } else {
        false
    };

    // 5. Atomic rename .tmp → .txt
    fs::rename(&tmp_path, &deps_path).map_err(|e| format!("failed to write deps file: {}", e))?;

    // 6. Run uv pip install --requirement (resolves transitive deps)
    let venv_py = venv_python_path(folder_dir);
    let uv = uv_path.unwrap_or("uv.exe");

    let result = build_uv_sync_command(uv, &venv_py, &deps_path).output();

    match result {
        Ok(output) if output.status.success() => {
            // 7. Success — delete .bak, write new hash
            let _ = fs::remove_file(&bak_path);
            fs::write(&hash_path, &new_hash)
                .map_err(|e| format!("failed to write hash file: {}", e))?;
            Ok(())
        }
        Ok(output) => {
            // 8. Failure — restore .bak
            restore_backup(&bak_path, &deps_path, had_backup);
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("uv pip sync failed: {}", stderr.trim()))
        }
        Err(e) => {
            // 8. Failure (process spawn error) — restore .bak
            restore_backup(&bak_path, &deps_path, had_backup);
            Err(format!("failed to start uv pip sync: {}", e))
        }
    }
}

fn restore_backup(bak_path: &Path, deps_path: &Path, had_backup: bool) {
    if had_backup {
        let _ = fs::rename(bak_path, deps_path);
    } else {
        let _ = fs::remove_file(deps_path);
    }
}

// ── Cleanup ──────────────────────────────────────────────

/// Deletes the venv directory (in the script folder) and all dep files
/// for the folder's hash.
pub fn delete_venv(app_data: &Path, folder_dir: &Path) -> Result<(), String> {
    let folder_hash = folder_hash(&folder_dir.to_string_lossy());

    // Delete venv directory
    let vdir = venv_dir(folder_dir);
    if vdir.is_dir() {
        fs::remove_dir_all(&vdir)
            .map_err(|e| format!("failed to delete venv '{}': {}", vdir.to_string_lossy(), e))?;
    }

    // Delete dep files
    let paths = [
        deps_file_path(app_data, &folder_hash),
        deps_hash_file_path(app_data, &folder_hash),
        deps_backup_file_path(app_data, &folder_hash),
        deps_tmp_file_path(app_data, &folder_hash),
    ];
    for p in &paths {
        let _ = fs::remove_file(p);
    }

    Ok(())
}

// ── Read utilities ───────────────────────────────────────

/// Reads the contents of requirements.txt from a script directory.
/// Returns empty vec if the file doesn't exist.
pub fn read_requirements_txt(dir_path: &str) -> Result<Vec<String>, String> {
    let req_path = Path::new(dir_path).join("requirements.txt");
    if !req_path.is_file() {
        return Ok(Vec::new());
    }
    let content =
        fs::read_to_string(&req_path).map_err(|e| format!("failed to read requirements.txt: {}", e))?;
    let lines: Vec<String> = content
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect();
    Ok(lines)
}
/// Runs `uv sync` in the script folder for pyproject.toml-based projects.
///
/// Unlike `sync_deps` which uses `uv pip install --requirement`, this runs
/// `uv sync` directly in the folder so uv reads `pyproject.toml` and resolves
/// all declared dependencies. No hash caching is needed — uv itself detects
/// changes to `pyproject.toml` and the lockfile.
pub fn sync_project(
    app_data: &Path,
    folder_dir: &Path,
    python_version: &str,
    uv_path: Option<&str>,
) -> Result<(), String> {
    let uv = uv_path.unwrap_or("uv.exe");

    // Ensure .venv is healthy first
    ensure_venv(app_data, folder_dir, python_version, uv_path)?;

    let output = std::process::Command::new(uv)
        .args(["sync", "--python", python_version, "--quiet"])
        .current_dir(folder_dir)
        .output()
        .map_err(|e| format!("failed to start uv sync: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("uv sync failed: {}", stderr.trim()))
    }
}

pub fn read_deps_hash(app_data: &Path, folder_hash: &str) -> Result<String, String> {
    let path = deps_hash_file_path(app_data, folder_hash);
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("failed to read hash file '{}': {}", path.to_string_lossy(), e))?;
    Ok(content.trim().to_string())
}

/// Writes the new hash to deps/<hash>.sha256.
pub fn write_deps_hash(app_data: &Path, folder_hash: &str, hash: &str) -> Result<(), String> {
    let path = deps_hash_file_path(app_data, folder_hash);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create deps dir: {}", e))?;
    }
    fs::write(&path, hash).map_err(|e| format!("failed to write hash: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("venv_test_{}_{}", std::process::id(), label));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    // ── Folder hash tests ────────────────────────────────

    #[test]
    fn folder_hash_is_deterministic() {
        let h1 = folder_hash("D:\\scripts\\analytics");
        let h2 = folder_hash("d:\\scripts\\analytics");
        assert_eq!(h1, h2, "same path different case must match");
        assert_eq!(h1.len(), 16, "hash must be 16 hex chars");
        // All hex chars
        assert!(h1.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn folder_hash_differs_for_diff_paths() {
        let h1 = folder_hash("D:\\scripts\\analytics");
        let h2 = folder_hash("D:\\scripts\\reports");
        assert_ne!(h1, h2);
    }

    #[test]
    fn folder_hash_handles_trailing_slash() {
        let h1 = folder_hash("D:\\scripts\\analytics");
        let h2 = folder_hash("D:\\scripts\\analytics\\");
        assert_eq!(h1, h2, "trailing slash must not affect hash");
    }

    #[test]
    fn folder_hash_handles_forward_slash() {
        let h1 = folder_hash("D:\\scripts\\analytics");
        let h2 = folder_hash("D:/scripts/analytics");
        assert_eq!(h1, h2, "forward slashes must produce same hash");
    }

    // ── Path helper tests ────────────────────────────────

    #[test]
    fn venv_python_path_points_into_script_folder() {
        let folder = PathBuf::from("D:\\\\LEARN\\\\python\\\\hello");
        let vdir = venv_dir(&folder);
        let s = vdir.to_string_lossy();
        assert!(s.ends_with(".venv"), "expected .venv in script folder, got: {}", s);

        let py = venv_python_path(&folder).to_string_lossy().to_string();
        assert!(py.contains(".venv"));
        assert!(py.ends_with("python.exe"));

        let cfg = venv_cfg_path(&folder).to_string_lossy().to_string();
        assert!(cfg.ends_with("pyvenv.cfg"));
    }

    #[test]
    fn deps_file_path_has_txt_extension() {
        let app_data = PathBuf::from("C:\\appdata");
        let path = deps_file_path(&app_data, "a1b2");
        let s = path.to_string_lossy();
        assert!(s.contains("deps"));
        assert!(s.ends_with("a1b2.txt"));
    }

    #[test]
    fn deps_hash_file_path_has_sha256_extension() {
        let app_data = PathBuf::from("C:\\appdata");
        let path = deps_hash_file_path(&app_data, "a1b2");
        let s = path.to_string_lossy();
        assert!(s.ends_with("a1b2.sha256"));
    }

    #[test]
    fn backup_and_tmp_paths_have_correct_suffixes() {
        let app_data = PathBuf::from("C:\\appdata");
        assert!(deps_backup_file_path(&app_data, "a1b2")
            .to_string_lossy()
            .ends_with(".txt.bak"));
        assert!(deps_tmp_file_path(&app_data, "a1b2")
            .to_string_lossy()
            .ends_with(".txt.tmp"));
    }

    // ── Requirement combinator tests ─────────────────────

    #[test]
    fn combine_requirements_deduplicates_and_sorts() {
        let result = combine_requirements(&[
            vec!["pandas".to_string(), "requests".to_string()],
            vec!["numpy".to_string(), "pandas".to_string()],
        ]);
        assert_eq!(result, vec!["numpy", "pandas", "requests"]);
    }

    #[test]
    fn combine_requirements_empty_input() {
        let result: Vec<String> = combine_requirements(&[]);
        assert!(result.is_empty());
    }

    #[test]
    fn combine_requirements_handles_empty_vectors() {
        let result = combine_requirements(&[
            vec![],
            vec!["requests".to_string()],
            vec![],
        ]);
        assert_eq!(result, vec!["requests"]);
    }

    #[test]
    fn combine_requirements_ignores_whitespace_only() {
        let result = combine_requirements(&[vec!["  ".to_string(), "pandas".to_string()]]);
        assert_eq!(result, vec!["pandas"]);
    }

    // ── Hash tests ───────────────────────────────────────

    #[test]
    fn compute_requirements_hash_changes_on_different_deps() {
        let h1 = compute_requirements_hash(&["pandas".to_string()]);
        let h2 = compute_requirements_hash(&["numpy".to_string()]);
        assert_ne!(h1, h2);
    }

    #[test]
    fn compute_requirements_hash_is_deterministic() {
        let h1 = compute_requirements_hash(&["pandas".to_string(), "numpy".to_string()]);
        let h2 = compute_requirements_hash(&["pandas".to_string(), "numpy".to_string()]);
        assert_eq!(h1, h2);
    }

    #[test]
    fn compute_requirements_hash_order_matters() {
        let h1 = compute_requirements_hash(&["pandas".to_string(), "numpy".to_string()]);
        let h2 = compute_requirements_hash(&["numpy".to_string(), "pandas".to_string()]);
        assert_ne!(h1, h2, "order should affect hash — sorted input is caller's responsibility");
    }

    #[test]
    fn compute_deps_fresh_returns_true_when_match() {
        assert!(compute_deps_fresh(
            &compute_requirements_hash(&["pandas".to_string()]),
            &["pandas".to_string()],
        ));
    }

    #[test]
    fn compute_deps_fresh_returns_false_when_mismatch() {
        assert!(!compute_deps_fresh("abc123", &["numpy".to_string()]));
    }

    #[test]
    fn compute_deps_fresh_returns_false_on_empty_hash() {
        assert!(!compute_deps_fresh("", &["numpy".to_string()]));
    }

    // ── Health check tests ───────────────────────────────

    #[test]
    fn check_venv_health_reports_healthy() {
        let dir = temp_dir("health_ok");
        let venv_dir = dir.join(".venv");
        fs::create_dir_all(venv_dir.join("Scripts")).unwrap();
        fs::write(venv_dir.join("Scripts").join("python.exe"), "").unwrap();
        fs::write(venv_dir.join("pyvenv.cfg"), "version = 3.11.5\n").unwrap();

        let result = check_venv_health(&dir, "3.11");
        assert!(result.is_ok());
        assert!(result.unwrap().contains("python.exe"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn check_venv_health_reports_healthy_for_uv_pyvenv_cfg() {
        // uv writes `version_info = 3.11` in pyvenv.cfg (not `version = 3.11.5`
        // which python -m venv writes). Health check must accept both formats.
        let dir = temp_dir("health_uv_cfg");
        let venv_dir = dir.join(".venv");
        fs::create_dir_all(venv_dir.join("Scripts")).unwrap();
        fs::write(venv_dir.join("Scripts").join("python.exe"), "").unwrap();
        fs::write(
            venv_dir.join("pyvenv.cfg"),
            "home = C:\\\\uv\\\\python\\\\cpython-3.11-windows-x86_64-none\n\
             implementation = CPython\n\
             uv = 0.11.26\n\
             version_info = 3.11\n\
             include-system-site-packages = false\n",
        )
        .unwrap();

        let result = check_venv_health(&dir, "3.11");
        assert!(result.is_ok());
        assert!(result.unwrap().contains("python.exe"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn check_venv_health_fails_on_missing_python() {
        let dir = temp_dir("health_missing_py");
        let result = check_venv_health(&dir, "3.11");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("python.exe"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn check_venv_health_fails_on_version_mismatch() {
        let dir = temp_dir("health_version");
        let venv_dir = dir.join(".venv");
        fs::create_dir_all(venv_dir.join("Scripts")).unwrap();
        fs::write(venv_dir.join("Scripts").join("python.exe"), "").unwrap();
        fs::write(venv_dir.join("pyvenv.cfg"), "version = 3.10.0\n").unwrap();

        let result = check_venv_health(&dir, "3.11");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("3.11"), "error should mention expected version: {}", err);
        assert!(err.contains("3.10"), "error should mention actual version: {}", err);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn check_venv_health_fails_on_missing_pyvenv_cfg() {
        let dir = temp_dir("health_no_cfg");
        let venv_dir = dir.join(".venv");
        fs::create_dir_all(venv_dir.join("Scripts")).unwrap();
        fs::write(venv_dir.join("Scripts").join("python.exe"), "").unwrap();
        // No pyvenv.cfg

        let result = check_venv_health(&dir, "3.11");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("pyvenv.cfg"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "requires uv on PATH; run explicitly with cargo test -- --ignored live_venv_create_and_sync"]
    fn live_venv_create_and_sync() {
        // Live verification of the full new path against real uv:
        // ensure_venv creates <folder>/.venv, sync_deps installs requirements
        // into it, and the venv python can import the installed dep.
        let dir = temp_dir("live_venv");
        let folder_dir = dir.join("scripts");
        fs::create_dir_all(&folder_dir).unwrap();
        fs::write(folder_dir.join("requirements.txt"), "openpyxl\n").unwrap();
        let folder_hash = folder_hash(&folder_dir.to_string_lossy());

        // ensure_venv creates the local .venv
        let py = ensure_venv(&dir, &folder_dir, "3.11", None).expect("ensure_venv should create .venv");
        assert!(py.ends_with(".venv\\Scripts\\python.exe") || py.ends_with(".venv/Scripts/python.exe"),
            "venv python should be inside <folder>/.venv, got: {}", py);
        assert!(venv_dir(&folder_dir).is_dir(), ".venv dir should exist");

        // sync_deps installs openpyxl (+ transitive et_xmlfile)
        let reqs = read_requirements_txt(&folder_dir.to_string_lossy()).unwrap();
        sync_deps(&dir, &folder_dir, &reqs, None).expect("sync_deps should install deps");
        assert!(deps_hash_file_path(&dir, &folder_hash).is_file(), "deps hash cache should exist");

        // The venv python actually runs the script importing the dep
        let script = folder_dir.join("check.py");
        fs::write(&script, "import openpyxl\nprint('openpyxl-ok')\n").unwrap();
        let out = std::process::Command::new(&py)
            .arg(&script)
            .output()
            .expect("run script in venv");
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(out.status.success(), "venv python should run: {}", String::from_utf8_lossy(&out.stderr));
        assert!(stdout.contains("openpyxl-ok"), "stdout: {}", stdout);

        // Idempotency: second ensure is a no-op health check pass
        let py2 = ensure_venv(&dir, &folder_dir, "3.11", None).unwrap();
        assert_eq!(py, py2);

        // delete_venv removes the local .venv and cache
        delete_venv(&dir, &folder_dir).unwrap();
        assert!(!venv_dir(&folder_dir).exists(), ".venv should be deleted");
        assert!(!deps_hash_file_path(&dir, &folder_hash).exists(), "deps cache should be deleted");

        let _ = fs::remove_dir_all(&dir);
    }

    // ── Deps sync file I/O tests ────────────────────────

    #[test]
    fn sync_deps_writes_requirements_file_and_creates_backup() {
        let dir = temp_dir("sync_deps_io");
        let folder_dir = dir.join("scripts");
        fs::create_dir_all(&folder_dir).unwrap();
        let folder_hash = folder_hash(&folder_dir.to_string_lossy());
        let deps_dir = dir.join("deps");
        fs::create_dir_all(&deps_dir).unwrap();

        // Simulate previous deps with known content and hash
        let hash = compute_requirements_hash(&["oldpkg".to_string()]);
        fs::write(deps_hash_file_path(&dir, &folder_hash), &hash).unwrap();
        fs::write(deps_file_path(&dir, &folder_hash), "oldpkg\n").unwrap();

        // Now sync with new deps — hash differs so should proceed
        let result = sync_deps_io_only(
            &dir,
            &folder_hash,
            &["pandas".to_string(), "requests".to_string()],
        );
        assert!(result.is_ok());

        // Verify file was written
        let content = fs::read_to_string(deps_file_path(&dir, &folder_hash)).unwrap();
        assert_eq!(content, "pandas\nrequests");

        // Verify hash was updated
        let new_hash = fs::read_to_string(deps_hash_file_path(&dir, &folder_hash)).unwrap();
        assert_eq!(
            new_hash,
            compute_requirements_hash(&["pandas".to_string(), "requests".to_string()])
        );

        // Backup should be gone on success
        assert!(!deps_backup_file_path(&dir, &folder_hash).exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sync_deps_skips_when_hash_unchanged() {
        let dir = temp_dir("sync_deps_skip");
        let folder_dir = dir.join("scripts");
        fs::create_dir_all(&folder_dir).unwrap();
        let folder_hash = folder_hash(&folder_dir.to_string_lossy());
        let deps_dir = dir.join("deps");
        fs::create_dir_all(&deps_dir).unwrap();

        let hash = compute_requirements_hash(&["pandas".to_string()]);
        fs::write(deps_hash_file_path(&dir, &folder_hash), &hash).unwrap();
        fs::write(deps_file_path(&dir, &folder_hash), "pandas\n").unwrap();

        // Track timestamp to detect if file was re-written
        let original_meta = fs::metadata(deps_file_path(&dir, &folder_hash)).unwrap();
        let original_modified = original_meta.modified().unwrap();

        // Sync with same deps
        std::thread::sleep(std::time::Duration::from_millis(50)); // ensure time diff
        let result = sync_deps_io_only(&dir, &folder_hash, &["pandas".to_string()]);
        assert!(result.is_ok());

        // File should NOT have been re-written (skip)
        let new_meta = fs::metadata(deps_file_path(&dir, &folder_hash)).unwrap();
        assert_eq!(
            original_modified, new_meta.modified().unwrap(),
            "file should not be modified when deps unchanged"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sync_deps_restores_backup_on_failure() {
        let dir = temp_dir("sync_deps_fail");
        let folder_dir = dir.join("scripts");
        fs::create_dir_all(&folder_dir).unwrap();
        let folder_hash = folder_hash(&folder_dir.to_string_lossy());
        let deps_dir = dir.join("deps");
        fs::create_dir_all(&deps_dir).unwrap();

        // Initial deps
        fs::write(deps_file_path(&dir, &folder_hash), "original_dep\n").unwrap();
        let old_hash = compute_requirements_hash(&["original_dep".to_string()]);
        fs::write(deps_hash_file_path(&dir, &folder_hash), &old_hash).unwrap();

        // Simulate failure during sync (pass bogus requirements.json to trigger failure)
        // We use sync_deps_restore_test which mimics the write + backup flow
        // but signals failure after the rename
        let result = sync_deps_with_simulated_failure(
            &dir,
            &folder_hash,
            &["new_dep".to_string()],
        );
        // Should be error
        assert!(result.is_err(), "sync should fail");

        // Original content should be restored
        let content = fs::read_to_string(deps_file_path(&dir, &folder_hash)).unwrap();
        assert_eq!(content, "original_dep\n", "original should be restored after failure");

        // Hash should remain unchanged (not updated on failure)
        let current_hash = fs::read_to_string(deps_hash_file_path(&dir, &folder_hash)).unwrap();
        assert_eq!(current_hash, old_hash, "hash should not change on failure");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sync_deps_uses_pip_install_requirement_to_resolve_transitive_deps() {
        // Regression: `uv pip sync` installs ONLY the packages listed in the
        // deps file and never their transitive dependencies (e.g. openpyxl
        // without et-xmlfile), which made hello_world.py fail with
        // `ModuleNotFoundError: No module named 'et_xmlfile'`.
        // The sync command must be `uv pip install --requirement <file>`
        // so the full dependency graph is resolved and installed.
        let dir = temp_dir("sync_cmd");
        let folder_dir = dir.join("scripts");
        fs::create_dir_all(&folder_dir).unwrap();
        let folder_hash = folder_hash(&folder_dir.to_string_lossy());
        let venv_py = venv_python_path(&folder_dir);
        let deps = deps_file_path(&dir, &folder_hash);

        let cmd = build_uv_sync_command("uv.exe", &venv_py, &deps);
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();

        assert_eq!(args[0], "pip", "expected `pip` subcommand, got: {:?}", args);
        assert_eq!(
            args[1], "install",
            "must use `pip install` (not `pip sync`), got: {:?}",
            args
        );
        assert!(
            args.contains(&"--requirement".to_string()),
            "must pass --requirement, got: {:?}",
            args
        );
        assert!(
            args.contains(&deps.to_string_lossy().to_string()),
            "must pass the deps file, got: {:?}",
            args
        );
        assert!(
            args.contains(&"--python".to_string()),
            "must pass --python, got: {:?}",
            args
        );

        let _ = fs::remove_dir_all(&dir);
    }

    // ── Delete tests ─────────────────────────────────────

    #[test]
    fn delete_venv_removes_directory_and_dep_files() {
        let dir = temp_dir("delete_test");
        let folder_dir = dir.join("scripts");
        fs::create_dir_all(&folder_dir).unwrap();
        let folder_hash = folder_hash(&folder_dir.to_string_lossy());
        let vdir = venv_dir(&folder_dir);
        fs::create_dir_all(vdir.join("Scripts")).unwrap();
        fs::write(vdir.join("Scripts").join("python.exe"), "").unwrap();
        // Ensure deps parent dir exists before writing
        let deps_dir = dir.join("deps");
        fs::create_dir_all(&deps_dir).unwrap();
        fs::write(deps_file_path(&dir, &folder_hash), "pandas").unwrap();
        fs::write(deps_hash_file_path(&dir, &folder_hash), "hash").unwrap();

        delete_venv(&dir, &folder_dir).unwrap();

        assert!(!venv_dir(&folder_dir).exists(), "venv dir should be deleted");
        assert!(!deps_file_path(&dir, &folder_hash).exists(), "deps file should be deleted");
        assert!(!deps_hash_file_path(&dir, &folder_hash).exists(), "hash file should be deleted");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_venv_noops_on_nonexistent() {
        let dir = temp_dir("delete_noop");
        let folder_dir = dir.join("no_such_folder");
        let result = delete_venv(&dir, &folder_dir);
        assert!(result.is_ok(), "deleting non-existent venv should be ok");
        let _ = fs::remove_dir_all(&dir);
    }

    // ── Read requirements.txt tests ─────────────────────────

    #[test]
    fn read_requirements_txt_returns_empty_when_no_file() {
        let dir = temp_dir("req_missing");
        let result = read_requirements_txt(&dir.to_string_lossy()).unwrap();
        assert!(result.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_requirements_txt_parses_lines() {
        let dir = temp_dir("req_parse");
        let req_path = dir.join("requirements.txt");
        fs::write(&req_path, "pandas>=2.0\nrequests\n# comment\nnumpy\n\n").unwrap();
        let result = read_requirements_txt(&dir.to_string_lossy()).unwrap();
        assert_eq!(result, vec!["pandas>=2.0", "requests", "numpy"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_requirements_txt_skips_comments_and_empty_lines() {
        let dir = temp_dir("req_skip");
        let req_path = dir.join("requirements.txt");
        fs::write(&req_path, "# this is a comment\n\n  \npandas\n").unwrap();
        let result = read_requirements_txt(&dir.to_string_lossy()).unwrap();
        assert_eq!(result, vec!["pandas"]);
        let _ = fs::remove_dir_all(&dir);
    }

    // ── Read/write hash tests ───────────────────────────

    #[test]
    fn write_and_read_deps_hash_roundtrip() {
        let dir = temp_dir("hash_roundtrip");
        write_deps_hash(&dir, "hash_test", "expected_hash_value").unwrap();
        let read = read_deps_hash(&dir, "hash_test").unwrap();
        assert_eq!(read, "expected_hash_value");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_deps_hash_fails_on_missing() {
        let dir = temp_dir("hash_missing");
        let result = read_deps_hash(&dir, "no_such_hash");
        assert!(result.is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    // ── Normalize tests ───────────────────────────────────

    #[test]
    fn normalize_path_lowercases_drive_letter() {
        assert_eq!(normalize_path("D:\\Scripts\\Analytics"), "d:/scripts/analytics");
    }

    #[test]
    fn normalize_path_converts_backslashes() {
        assert_eq!(normalize_path("C:\\Users\\test"), "c:/users/test");
    }

    #[test]
    fn normalize_path_strips_trailing_slash() {
        assert_eq!(normalize_path("/home/user/"), "/home/user");
    }

    // ── Fake helpers for testing I/O without uv ──────────

    /// Pure file I/O part of sync_deps (no uv subprocess).
    /// Returns Ok(()) on success.
    fn sync_deps_io_only(
        app_data: &Path,
        folder_hash: &str,
        requirements: &[String],
    ) -> Result<(), String> {
        let new_hash = compute_requirements_hash(requirements);

        // Check cached hash
        let hash_path = deps_hash_file_path(app_data, folder_hash);
        if hash_path.is_file() {
            let cached = fs::read_to_string(&hash_path).unwrap_or_default();
            if compute_deps_fresh(cached.trim(), requirements) {
                return Ok(());
            }
        }

        let deps_path = deps_file_path(app_data, folder_hash);
        let tmp_path = deps_tmp_file_path(app_data, folder_hash);
        let bak_path = deps_backup_file_path(app_data, folder_hash);

        if let Some(parent) = deps_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
        }

        // Atomic write
        let content = requirements.join("\n");
        fs::write(&tmp_path, &content).map_err(|e| format!("write tmp: {}", e))?;

        let had_backup = if deps_path.is_file() {
            fs::rename(&deps_path, &bak_path).map_err(|e| format!("backup: {}", e))?;
            true
        } else {
            false
        };

        fs::rename(&tmp_path, &deps_path).map_err(|e| format!("rename: {}", e))?;

        // Simulate success — delete backup, write hash
        let _ = fs::remove_file(&bak_path);
        fs::write(&hash_path, &new_hash).map_err(|e| format!("write hash: {}", e))?;
        Ok(())
    }

    /// Simulates sync_deps where the uv step fails, testing backup restore.
    fn sync_deps_with_simulated_failure(
        app_data: &Path,
        folder_hash: &str,
        requirements: &[String],
    ) -> Result<(), String> {
        let new_hash = compute_requirements_hash(requirements);
        let deps_path = deps_file_path(app_data, folder_hash);
        let tmp_path = deps_tmp_file_path(app_data, folder_hash);
        let bak_path = deps_backup_file_path(app_data, folder_hash);

        if let Some(parent) = deps_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
        }

        let content = requirements.join("\n");
        fs::write(&tmp_path, &content).map_err(|e| format!("write tmp: {}", e))?;

        let had_backup = if deps_path.is_file() {
            fs::rename(&deps_path, &bak_path).map_err(|e| format!("backup: {}", e))?;
            true
        } else {
            false
        };

        fs::rename(&tmp_path, &deps_path).map_err(|e| format!("rename: {}", e))?;

        // Simulate uv pip sync failure
        let _ = fs::write(&tmp_path, "simulated_failure_marker");
        drop(new_hash); // hash not used since we fail

        // Restore
        if had_backup {
            let _ = fs::rename(&bak_path, &deps_path);
        } else {
            let _ = fs::remove_file(&deps_path);
        }

        Err("simulated uv pip sync failure".to_string())
    }
}