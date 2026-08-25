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
      default:
        return Promise.resolve(null)
    }
  })
})

function labels(result: HostHealthResult): string[] {
  return result.items.map((i) => i.label)
}

describe('checkHostHealth', () => {
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
    expect(item?.status).toBe('ok')
    expect(item?.detail).toContain('per-venv')
  })

  it('marks the uv item as a warning when not met', async () => {
    const result = await checkHostHealth(runtimeResult('notMet'))

    const item = result.items.find((i) => i.key === 'python-runtime')
    expect(item?.status).toBe('warning')
  })

  it('marks the uv item as an error when the runtime check failed', async () => {
    const result = await checkHostHealth(runtimeResult('failed'))

    const item = result.items.find((i) => i.key === 'python-runtime')
    expect(item?.status).toBe('error')
  })

  it('aggregates to ok / warning / failing from item statuses', async () => {
    const allOk = await checkHostHealth(runtimeResult('met'))
    expect(allOk.status).toBe('ok')

    const warned = await checkHostHealth(runtimeResult('notMet'))
    expect(warned.status).toBe('warning')

    const broken = await checkHostHealth(runtimeResult('failed'))
    expect(broken.status).toBe('failing')
  })
})
