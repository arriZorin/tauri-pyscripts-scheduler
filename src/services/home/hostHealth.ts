import { invoke } from '@tauri-apps/api/core'
import type { RequirementCheckResult } from '../runtimeCheck/types'

export type HealthStatus = 'ok' | 'warning' | 'error'

export interface HostHealthItem {
  /** Stable test/hook key — independent of the user-facing label. */
  key: string
  label: string
  /** Drives the per-item icon (✓ / ! / ✗) and the card aggregate. */
  status: HealthStatus
  detail: string
}

export interface HostHealthResult {
  items: HostHealthItem[]
  status: 'ok' | 'warning' | 'failing'
}

export interface HostHealthService {
  check(runtimeResult?: RequirementCheckResult | null): Promise<HostHealthResult>
}

/**
 * Checks several host-environment preconditions that could break the app.
 *
 * - **Task Scheduler** — probes the COM API via `list_scheduled_tasks`.
 *   If it errors, the Schedule service is down or permissions are blocked.
 * - **Winget** — checks if `winget.exe` is on PATH (primary uv bootstrap path).
 *   Only probed while uv is not met — once uv is installed, winget presence
 *   has no effect on the app.
 * - **App data writable** — writes a temporary marker to the app data dir
 *   and deletes it.
 * - **Disk free space** — queries free bytes on the app-data drive.
 *   Warning if < 500 MB, error if < 100 MB.
 * - **Python runtime (uv)** — reads the cached startup check result. The app
 *   delegates Python to uv, so this reports on the uv manager, not a Python
 *   interpreter. `notMet`/`deferred` are warnings (fixable in-app via
 *   Resolve), `failed` is an error.
 */
export async function checkHostHealth(runtimeResult?: RequirementCheckResult | null): Promise<HostHealthResult> {
  const items: HostHealthItem[] = []

  // 1. Task Scheduler
  await checkTaskScheduler(items)

  // 2. Winget availability — only matters while uv still needs bootstrapping.
  if (!runtimeResult || runtimeResult.status !== 'met') {
    await checkWinget(items)
  }

  // 3. App data dir writable
  await checkAppDataWritable(items)

  // 4. Disk free space
  await checkDiskFreeSpace(items)

  // 5. Python runtime
  checkPythonRuntime(items, runtimeResult)

  const errors = items.filter(i => i.status === 'error').length
  const warnings = items.filter(i => i.status === 'warning').length
  const status: HostHealthResult['status'] =
    errors > 0 ? 'failing' : warnings > 0 ? 'warning' : 'ok'

  return { items, status }
}

async function checkTaskScheduler(items: HostHealthItem[]): Promise<void> {
  try {
    await invoke<string[]>('list_scheduled_tasks')
    items.push({
      key: 'task-scheduler',
      label: 'Task Scheduler',
      status: 'ok',
      detail: 'COM API responds',
    })
  } catch {
    items.push({
      key: 'task-scheduler',
      label: 'Task Scheduler',
      status: 'error',
      detail: 'Service unavailable — creating/running tasks will fail',
    })
  }
}

async function checkWinget(items: HostHealthItem[]): Promise<void> {
  try {
    const result = await invoke<string[]>('find_all_in_path_command', { name: 'winget' })
    if (result.length > 0) {
      items.push({
        key: 'winget',
        label: 'Winget',
        status: 'ok',
        detail: 'Found — primary uv bootstrap path available',
      })
    } else {
      items.push({
        key: 'winget',
        label: 'Winget',
        status: 'ok',
        detail: 'Not found — uv bootstrap will use zip download fallback',
      })
    }
  } catch {
    items.push({
      key: 'winget',
      label: 'Winget',
      status: 'ok',
      detail: 'Could not check — zip fallback will be used',
    })
  }
}

async function checkAppDataWritable(items: HostHealthItem[]): Promise<void> {
  try {
    const marker = '_hermes_health_marker'
    await invoke('write_text_file', { path: marker, content: 'ok' })
    const readBack = await invoke<string | null>('read_text_file', { path: marker })
    // Verify it was written; then overwrite to clean up
    if (readBack === 'ok') {
      await invoke('write_text_file', { path: marker, content: '' })
      items.push({
        key: 'app-data-dir',
        label: 'App Data Dir',
        status: 'ok',
        detail: 'Writable — persistence layer works',
      })
    } else {
      items.push({
        key: 'app-data-dir',
        label: 'App Data Dir',
        status: 'error',
        detail: 'Write verification failed',
      })
    }
  } catch {
    items.push({
      key: 'app-data-dir',
      label: 'App Data Dir',
      status: 'error',
      detail: 'Not writable — all persistence operations will fail',
    })
  }
}

async function checkDiskFreeSpace(items: HostHealthItem[]): Promise<void> {
  try {
    // Query free space on the drive that holds the app data dir — that is the
    // disk that actually matters (JSON persistence + venvs live there).
    // Note: `process.env` is NOT available in the Tauri webview, so the drive
    // must come from Rust (get_app_data_dir), never from the Node process.
    const appDataDir = await invoke<string>('get_app_data_dir')
    const drive = appDataDir.substring(0, 2) // e.g. "C:"
    const freeBytes = await invoke<number>('get_disk_free_space', { path: drive + '\\' })
    const freeMb = Math.round(freeBytes / (1024 * 1024))

    if (freeMb < 100) {
      items.push({
        key: 'disk-space',
        label: 'Disk Space',
        status: 'error',
        detail: `${freeMb} MB free — critical, below 100 MB`,
      })
    } else if (freeMb < 500) {
      items.push({
        key: 'disk-space',
        label: 'Disk Space',
        status: 'warning',
        detail: `Warning: only ${freeMb} MB free — below 500 MB`,
      })
    } else {
      const gb = (freeMb / 1024).toFixed(1)
      items.push({
        key: 'disk-space',
        label: 'Disk Space',
        status: 'ok',
        detail: `${gb} GB free`,
      })
    }
  } catch {
    items.push({
      key: 'disk-space',
      label: 'Disk Space',
      status: 'warning',
      detail: 'Could not query',
    })
  }
}

function checkPythonRuntime(items: HostHealthItem[], result: RequirementCheckResult | null | undefined): void {
  if (!result) {
    items.push({
      key: 'python-runtime',
      label: 'uv (Python manager)',
      status: 'ok',
      detail: 'Checking...',
    })
    return
  }
  switch (result.status) {
    case 'met':
      items.push({
        key: 'python-runtime',
        label: 'uv (Python manager)',
        status: 'ok',
        detail: `uv found — Python resolves per-venv when tasks run${result.resolvedPath ? ` (${result.resolvedPath})` : ''}`,
      })
      break
    case 'notMet':
    case 'deferred':
      items.push({
        key: 'python-runtime',
        label: 'uv (Python manager)',
        status: 'warning',
        detail: `Warning: ${result.message}`,
      })
      break
    case 'failed':
      items.push({
        key: 'python-runtime',
        label: 'uv (Python manager)',
        status: 'error',
        detail: result.message,
      })
      break
  }
}

export const tauriHostHealthService: HostHealthService = {
  check: checkHostHealth,
}
