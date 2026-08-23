import { invoke } from '@tauri-apps/api/core'
import type { ScriptRepository } from './ScriptRepository'

export interface VenvSync {
  /** Ensure venv exists and deps are synced for the folder containing a script. */
  syncFolder(scriptPath: string, pythonVersion: string): Promise<void>

  /** Delete venv if no scripts remain in the folder, otherwise re-sync. */
  cleanupFolder(scriptPath: string): Promise<void>
}

export class TauriVenvSync implements VenvSync {
  constructor(private readonly scriptRepository: ScriptRepository) {}

  async syncFolder(scriptPath: string, pythonVersion: string): Promise<void> {
    const workingDir = scriptDir(scriptPath)

    // Check for pyproject.toml — if present, use uv sync (project mode)
    const hasPyproject = await invoke<boolean>('path_exists', { path: workingDir + '/pyproject.toml' })
    if (hasPyproject) {
      await invoke('ensure_script_venv', { dirPath: workingDir, pythonVersion })
      await invoke('uv_sync_project', { dirPath: workingDir, pythonVersion })
      return
    }

    // Read requirements.txt from the script folder (or empty if not found)
    const requirements = await invoke<string[]>('read_folder_requirements', { dirPath: workingDir })

    // Ensure venv exists in the script folder (health check first — 0 subprocess if healthy)
    await invoke('ensure_script_venv', { dirPath: workingDir, pythonVersion })

    // Sync deps if there are any requirements
    if (requirements.length > 0) {
      await invoke('sync_script_deps', { dirPath: workingDir, requirements })
    }
  }

  async cleanupFolder(scriptPath: string): Promise<void> {
    const workingDir = scriptDir(scriptPath)

    // Check if any scripts remain in this folder
    const allScripts = await this.scriptRepository.list()
    const remaining = allScripts.filter(s =>
      scriptDir(s.path).toLowerCase() === workingDir.toLowerCase()
    )

    if (remaining.length === 0) {
      // No scripts left in this folder — delete the venv
      await invoke('delete_script_venv', { dirPath: workingDir })
    } else {
      // Re-sync with remaining scripts' requirements.txt
      const requirements = await invoke<string[]>('read_folder_requirements', { dirPath: workingDir })
      if (requirements.length > 0) {
        await invoke('sync_script_deps', { dirPath: workingDir, requirements })
      }
    }
  }
}

function scriptDir(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index === -1 ? path : normalized.slice(0, index)
}