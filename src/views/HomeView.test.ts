import { createApp, nextTick, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import HomeView from './HomeView.vue'
import { appContextKey, createAppContext } from '../composables/useAppContext'
import type { Task } from '../models/Task'
import type { TaskRun } from '../models/TaskRun'
import type { RequirementCheckResult, RuntimeRequirement } from '../services/runtimeCheck/types'
import type { HostHealthResult } from '../services/home/hostHealth'

function task(id: string, name: string): Task {
  return {
    id,
    name,
    scriptId: 'script-1',
    interpreter: 'python',
    arguments: [],
    schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' },
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    status: 'scheduled',
    createdAt: '',
    updatedAt: '',
  }
}

function run(id: string, taskId: string, startedAt: string, status: TaskRun['status'] = 'success'): TaskRun {
  return {
    id,
    taskId,
    startedAt,
    finishedAt: status === 'running' ? null : startedAt,
    status,
    exitCode: status === 'failed' ? 1 : status === 'running' ? null : 0,
    stdout: null,
    stderr: null,
  }
}

function runtimeResult(status: RequirementCheckResult['status']): RequirementCheckResult {
  return {
    status,
    requirementName: 'Python runtime',
    message: status === 'met' ? 'Python 3.12.10 found on host.' : 'No Python matching \'>=3.11\' found.',
    detail: status === 'met' ? null : 'Resolve tries: uv-managed install, then the official installer.',
    resolvedPath: status === 'met' ? 'C:\\Python312\\python.exe' : null,
  }
}

function fakeRuntimeRequirement(result: RequirementCheckResult): RuntimeRequirement {
  return {
    check: async () => result,
    resolve: async () => ({ ...result, status: 'met' as const, message: 'Python 3.12.10 found on host.' }),
  }
}

const emptyOverrides = {
  scriptRepository: { list: async () => [] } as never,
  taskRepository: { list: async () => [] } as never,
  taskRunRepository: { list: async () => [] } as never,
  hostHealth: { check: async (runtimeResult?: RequirementCheckResult | null): Promise<HostHealthResult> => {
    const items: { key: string; label: string; status: 'ok' | 'warning' | 'error'; detail: string }[] = []
    if (runtimeResult) {
      items.push({
        key: 'python-runtime',
        label: 'uv (Python manager)',
        status: runtimeResult.status === 'failed' ? 'error' : runtimeResult.status === 'met' ? 'ok' : 'warning',
        detail: runtimeResult.status === 'met' ? runtimeResult.message : `Warning: ${runtimeResult.message}`,
      })
    }
    return { items, status: 'ok' }
  } } as never,
}

async function mountHome(overrides: Record<string, unknown>, extraProps: Record<string, unknown> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(HomeView, extraProps)
  app.provide(appContextKey, createAppContext(overrides))
  app.mount(container)
  for (let index = 0; index < 5; index += 1) {
    await nextTick()
    await Promise.resolve()
  }
  return { container, app }
}

describe('HomeView recent executions', () => {
  it('renders the five newest executions with task names and status', async () => {
    const tasks = [task('task-1', 'Backup'), task('task-2', 'Cleanup')]
    const runs = [
      run('run-1', 'task-1', '2026-08-14T01:00:00.000Z'),
      run('run-2', 'task-2', '2026-08-14T02:00:00.000Z', 'failed'),
      run('run-3', 'task-1', '2026-08-14T03:00:00.000Z'),
      run('run-4', 'task-2', '2026-08-14T04:00:00.000Z'),
      run('run-5', 'task-1', '2026-08-14T05:00:00.000Z', 'running'),
      run('run-6', 'task-2', '2026-08-14T06:00:00.000Z'),
    ]

    const { container, app } = await mountHome({
      ...emptyOverrides,
      taskRepository: { list: async () => tasks } as never,
      taskRunRepository: { list: async () => runs } as never,
      runtimeRequirement: fakeRuntimeRequirement(runtimeResult('met')),
    })

    const rows = container.querySelectorAll('[data-testid^="recent-execution-row-"]')
    expect(rows).toHaveLength(5)
    expect(rows[0]?.getAttribute('data-testid')).toBe('recent-execution-row-run-6')
    expect(rows[4]?.getAttribute('data-testid')).toBe('recent-execution-row-run-2')
    expect(container.querySelector('[data-testid="recent-execution-row-run-1"]')).toBeNull()
    expect(container.querySelector('[data-testid="recent-executions-table"]')?.textContent).toContain('Cleanup')
    expect(container.querySelector('[data-testid="recent-executions-table"]')?.textContent).toContain('failed')
    expect(container.querySelector('[data-testid="recent-executions-table"]')?.textContent).toContain('running')

    app.unmount()
    document.body.removeChild(container)
  })

  it('renders host health checks in the health card', async () => {
    const { container, app } = await mountHome({
      ...emptyOverrides,
      runtimeRequirement: fakeRuntimeRequirement(runtimeResult('met')),
    })

    // The health card should render (it runs checkHostHealth async in loadStats)
    await nextTick()
    await nextTick()
    const healthCard = container.querySelector('[data-testid="host-health"]')
    expect(healthCard).toBeTruthy()
    expect(healthCard?.textContent).toContain('Host Health')

    app.unmount()
    document.body.removeChild(container)
  })
})

describe('HomeView runtime requirement card', () => {
  it('shows Python runtime line in host health with no Resolve button when met', async () => {
    const { container, app } = await mountHome({
      ...emptyOverrides,
      runtimeCheckResult: ref(runtimeResult('met')),
    })

    const healthItem = container.querySelector('[data-testid="health-python-runtime"]')
    expect(healthItem).toBeTruthy()
    expect(healthItem?.textContent).toContain('Python 3.12.10 found on host.')
    expect(container.querySelector('[data-testid="resolve-runtime"]')).toBeNull()

    app.unmount()
    document.body.removeChild(container)
  })

  it('shows a Resolve button when Python runtime is not met', async () => {
    const { container, app } = await mountHome({
      ...emptyOverrides,
      runtimeCheckResult: ref(runtimeResult('notMet')),
    })

    const healthItem = container.querySelector('[data-testid="health-python-runtime"]')
    expect(healthItem).toBeTruthy()
    expect(healthItem?.textContent).toContain('Warning')
    expect(container.querySelector('[data-testid="resolve-runtime"]')).not.toBeNull()

    app.unmount()
    document.body.removeChild(container)
  })

  it('resolves and flips the status to Met when Resolve is clicked', async () => {
    const { container, app } = await mountHome({
      ...emptyOverrides,
      runtimeRequirement: fakeRuntimeRequirement(runtimeResult('notMet')),
      runtimeCheckResult: ref(runtimeResult('notMet')),
    })

    const resolveButton = container.querySelector('[data-testid="resolve-runtime"]') as HTMLButtonElement
    expect(resolveButton).not.toBeNull()
    resolveButton.click()
    for (let index = 0; index < 5; index += 1) {
      await nextTick()
      await Promise.resolve()
    }

    expect(container.querySelector('[data-testid="resolve-runtime"]')).toBeNull()

    app.unmount()
    document.body.removeChild(container)
  })

  it('shows Try again for a deferred requirement', async () => {
    const { container, app } = await mountHome({
      ...emptyOverrides,
      runtimeCheckResult: ref(runtimeResult('deferred')),
    })

    const resolveButton = container.querySelector('[data-testid="resolve-runtime"]') as HTMLButtonElement
    expect(resolveButton).not.toBeNull()
    expect(resolveButton.textContent).toContain('Try again')

    app.unmount()
    document.body.removeChild(container)
  })

  it('renders an exclamation mark for warning health items (not a green check)', async () => {
    const { container, app } = await mountHome({
      ...emptyOverrides,
      runtimeCheckResult: ref(runtimeResult('notMet')),
    })

    const healthItem = container.querySelector('[data-testid="health-python-runtime"]')
    expect(healthItem).toBeTruthy()
    expect(healthItem?.textContent).toContain('!')
    expect(healthItem?.textContent).not.toContain('\u2713')

    app.unmount()
    document.body.removeChild(container)
  })

  it('re-runs the host health check when the refresh icon is clicked', async () => {
    let calls = 0
    const healthSpy = {
      check: async (): Promise<HostHealthResult> => {
        calls += 1
        return {
          items: [{ key: 'python-runtime', label: 'uv (Python manager)', status: 'ok', detail: 'ok' }],
          status: 'ok',
        }
      },
    }

    const { container, app } = await mountHome({
      ...emptyOverrides,
      hostHealth: healthSpy as never,
      runtimeCheckResult: ref(runtimeResult('met')),
    })
    expect(calls).toBe(1)

    const refreshButton = container.querySelector('[data-testid="refresh-health"]') as HTMLButtonElement
    expect(refreshButton).not.toBeNull()
    refreshButton.click()
    for (let index = 0; index < 5; index += 1) {
      await nextTick()
      await Promise.resolve()
    }

    expect(calls).toBe(2)

    app.unmount()
    document.body.removeChild(container)
  })
})
