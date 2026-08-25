import { invoke } from '@tauri-apps/api/core'

export interface FolderRevealer {
  reveal(scriptPath: string): Promise<void>
}

export class TauriFolderRevealer implements FolderRevealer {
  reveal(scriptPath: string): Promise<void> {
    return invoke('reveal_in_explorer', { path: scriptPath })
  }
}
