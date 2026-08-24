import { invoke } from '@tauri-apps/api/core'

export interface HostHealthItem {
  label: string
  ok: boolean
  detail: string
}

export interface HostHealthResult {
  items: HostHealthItem[]
  status: 'ok' | 'warning' | 'failing'
}

export interface HostHealthService {
  check(): Promise<HostHealthResult>
}

/**
 * Checks several host-environment preconditions that could break the app.
 *
 * - **Task Scheduler** — probes the COM API via `list_scheduled_tasks`.
 *   If it errors, the Schedule service is down or permissions are blocked.
 * - **Winget** — checks if `winget.exe` is on PATH (primary uv bootstrap path).
 * - **App data writable** — writes a temporary marker to the app data dir
 *   and deletes it.
 * - **Disk free space** — queries free bytes on the system drive.
 *   Warning if < 500 MB, failing if < 100 MB.
 */
export async function checkHostHealth(): Promise<HostHealthResult> {
  const items: HostHealthItem[] = []

  // 1. Task Scheduler
  await checkTaskScheduler(items)

  // 2. Winget availability
  await checkWinget(items)

  // 3. App data dir writable
  await checkAppDataWritable(items)

  // 4. Disk free space
  await checkDiskFreeSpace(items)

  const failing = items.filter(i => !i.ok).length
  const warnings = items.filter(i => i.ok && i.detail.includes('Warning')).length
  const status: HostHealthResult['status'] =
    failing > 0 ? 'failing' : warnings > 0 ? 'warning' : 'ok'

  return { items, status }
}

async function checkTaskScheduler(items: HostHealthItem[]): Promise<void> {
  try {
    await invoke<string[]>('list_scheduled_tasks')
    items.push({
      label: 'Task Scheduler',
      ok: true,
      detail: 'COM API responds',
    })
  } catch {
    items.push({
      label: 'Task Scheduler',
      ok: false,
      detail: 'Service unavailable — creating/running tasks will fail',
    })
  }
}

async function checkWinget(items: HostHealthItem[]): Promise<void> {
  try {
    const result = await invoke<string[]>('find_all_in_path_command', { name: 'winget' })
    if (result.length > 0) {
      items.push({
        label: 'Winget',
        ok: true,
        detail: 'Found — primary uv bootstrap path available',
      })
    } else {
      items.push({
        label: 'Winget',
        ok: true,
        detail: 'Not found — uv bootstrap will use zip download fallback',
      })
    }
  } catch {
    items.push({
      label: 'Winget',
      ok: true,
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
        label: 'App Data Dir',
        ok: true,
        detail: 'Writable — persistence layer works',
      })
    } else {
      items.push({
        label: 'App Data Dir',
        ok: false,
        detail: 'Write verification failed',
      })
    }
  } catch {
    items.push({
      label: 'App Data Dir',
      ok: false,
      detail: 'Not writable — all persistence operations will fail',
    })
  }
}

async function checkDiskFreeSpace(items: HostHealthItem[]): Promise<void> {
  try {
    // Query free space on the system drive (LOCALAPPDATA drive)
    const localAppData = process.env.LOCALAPPDATA || 'C:\\'
    const drive = localAppData.substring(0, 2) // e.g. "C:"
    const freeBytes = await invoke<number>('get_disk_free_space', { path: drive + '\\' })
    const freeMb = Math.round(freeBytes / (1024 * 1024))

    if (freeMb < 100) {
      items.push({
        label: 'Disk Space',
        ok: false,
        detail: `${freeMb} MB free — critical, below 100 MB`,
      })
    } else if (freeMb < 500) {
      items.push({
        label: 'Disk Space',
        ok: true,
        detail: `Warning: only ${freeMb} MB free — below 500 MB`,
      })
    } else {
      const gb = (freeMb / 1024).toFixed(1)
      items.push({
        label: 'Disk Space',
        ok: true,
        detail: `${gb} GB free`,
      })
    }
  } catch {
    items.push({
      label: 'Disk Space',
      ok: true,
      detail: 'Could not query',
    })
  }
}

export const tauriHostHealthService: HostHealthService = {
  check: checkHostHealth,
}