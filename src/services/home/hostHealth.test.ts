import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostHealthResult } from './hostHealth'
import type { RequirementCheckResult } from '../runtimeCheck/types'

const invokeMock = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

import { checkHostHealth } from './hostHealth'

function runtimeResult(status: RequirementCheckResult['status']): RequirementCheckResult {
  return {
    status,
    requirementName: 'Python runtime',
    message: status === 'met' ? 'uv is available at C:\\Users\\me\\uv.exe.' : 'uv is not installed.',
    detail: null,
    resolvedPath: status === 'met' ? 'C:\\Users\\me\\uv.exe' : null,
  }
}

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockImplementation((cmd: string) => {
    switch (cmd) {
      case 'list_scheduled_tasks':
        return Promise.resolve([])
      case 'find_all_in_path_command':
        return Promise.resolve(['C:\\Windows\\winget.exe'])
      case 'write_text_file':
        return Promise.resolve(null)
      case 'read_text_file':
        return Promise.resolve('ok')
      case 'get_app_data_dir':
        return Promise.resolve('C:\\Users\\me\\AppData\\Local\\com.pyscriptscheduler.app')
      case 'get_disk_free_space':
        return Promise.resolve(5 * 1024 * 1024 * 1024) // 5 GiB
      default:
        return Promise.resolve(null)
    }
  })
})

function labels(result: HostHealthResult): string[] {
  return result.items.map((i) => i.label)
}

describe('checkHostHealth', () => {
  it('queries disk space through get_app_data_dir + get_disk_free_space (no process.env)', async () => {
    const result = await checkHostHealth(runtimeResult('met'))

    expect(invokeMock).toHaveBeenCalledWith('get_app_data_dir')
    expect(invokeMock).toHaveBeenCalledWith('get_disk_free_space', { path: 'C:\\' })

    const disk = result.items.find((i) => i.label === 'Disk Space')
    expect(disk?.detail).toBe('5.0 GB free')
    expect(disk?.ok).toBe(true)
  })

  it('skips the winget probe when uv is met', async () => {
    const result = await checkHostHealth(runtimeResult('met'))

    expect(invokeMock).not.toHaveBeenCalledWith('find_all_in_path_command', { name: 'winget' })
    expect(labels(result)).not.toContain('Winget')
  })

  it('runs the winget probe when uv is not met', async () => {
    const result = await checkHostHealth(runtimeResult('notMet'))

    expect(invokeMock).toHaveBeenCalledWith('find_all_in_path_command', { name: 'winget' })
    expect(labels(result)).toContain('Winget')
  })

  it('labels the uv item as a Python manager and explains per-venv resolution when met', async () => {
    const result = await checkHostHealth(runtimeResult('met'))

    const item = result.items.find((i) => i.label.includes('uv'))
    expect(item?.label).toBe('uv (Python manager)')
    expect(item?.key).toBe('python-runtime')
    expect(item?.detail).toContain('per-venv')
    expect(item?.ok).toBe(true)
  })

  it('falls back to "Could not query" when the disk invoke fails', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_app_data_dir') return Promise.reject(new Error('no dir'))
      return Promise.resolve(null)
    })

    const result = await checkHostHealth(runtimeResult('met'))

    const disk = result.items.find((i) => i.label === 'Disk Space')
    expect(disk?.detail).toBe('Could not query')
    expect(disk?.ok).toBe(true)
  })
})
