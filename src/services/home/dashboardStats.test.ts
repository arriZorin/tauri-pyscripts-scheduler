import { describe, expect, it } from 'vitest'
import { computeDashboardStats } from './dashboardStats'
import type { Script } from '../../models/Script'
import type { Task } from '../../models/Task'
import type { TaskRun } from '../../models/TaskRun'

function script(overrides: Partial<Script> = {}): Script {
  return { id: 's1', name: 'a.py', path: 'C:/a.py', type: 'python', createdAt: '', updatedAt: '', ...overrides }
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1', name: 'Task', scriptId: 's1', interpreter: 'python', arguments: [],
    schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' },
    enabled: true, lastRunAt: null, nextRunAt: null, status: 'scheduled', createdAt: '', updatedAt: '',
    ...overrides,
  }
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'r1', taskId: 't1', startedAt: '', finishedAt: '', status: 'success', exitCode: 0,
    stdout: null, stderr: null, ...overrides,
  }
}

describe('computeDashboardStats', () => {
  it('counts scripts, tasks, and enabled tasks', () => {
    const stats = computeDashboardStats(
      [script(), script({ id: 's2' })],
      [task(), task({ id: 't2', enabled: false }), task({ id: 't3' })],
      [],
    )
    expect(stats.totalScripts).toBe(2)
    expect(stats.totalTasks).toBe(3)
    expect(stats.enabledTasks).toBe(2)
  })

  it('counts used and unused scripts', () => {
    const stats = computeDashboardStats(
      [script({ id: 's1' }), script({ id: 's2' }), script({ id: 's3' })],
      [task({ scriptId: 's1' }), task({ id: 't2', scriptId: 's2' })],
      [],
    )
    expect(stats.usedScripts).toBe(2)
    expect(stats.unusedScripts).toBe(1)
  })

  it('computes success rate from runs', () => {
    const stats = computeDashboardStats(
      [script()],
      [task()],
      [run(), run({ id: 'r2', status: 'success' }), run({ id: 'r3', status: 'failed' })],
    )
    expect(stats.totalRuns).toBe(3)
    expect(stats.successRuns).toBe(2)
    expect(stats.failedRuns).toBe(1)
    expect(stats.successRate).toBe(67)
  })

  it('rounds success rate to a whole percent', () => {
    const stats = computeDashboardStats([], [], [run(), run({ id: 'r2', status: 'failed' })])
    expect(stats.successRate).toBe(50)
  })

  it('success rate is 0 when there are no completed runs', () => {
    const stats = computeDashboardStats([], [], [])
    expect(stats.successRate).toBe(0)
    expect(stats.totalRuns).toBe(0)
  })

  it('ignores in-flight (running) runs in totals and success rate', () => {
    const stats = computeDashboardStats([], [], [run({ status: 'running' }), run({ status: 'success' })])
    expect(stats.totalRuns).toBe(1)
    expect(stats.successRuns).toBe(1)
    expect(stats.successRate).toBe(100)
  })

  it('picks the next scheduled run as the soonest enabled task', () => {
    const stats = computeDashboardStats(
      [],
      [
        task({ id: 't1', enabled: true, nextRunAt: '2026-08-25T03:00:00' }),
        task({ id: 't2', enabled: true, nextRunAt: '2026-08-24T03:00:00' }),
        task({ id: 't3', enabled: false, nextRunAt: '2026-08-23T03:00:00' }),
      ],
      [],
    )
    expect(stats.nextRunName).toBe('Task')
    expect(stats.nextRunAt).toBe('2026-08-24T03:00:00')
  })

  it('next run is null when no enabled task has a nextRunAt', () => {
    const stats = computeDashboardStats(
      [],
      [task({ enabled: true, nextRunAt: null }), task({ enabled: false, nextRunAt: '2026-08-24T03:00:00' })],
      [],
    )
    expect(stats.nextRunAt).toBeNull()
    expect(stats.nextRunName).toBeNull()
  })

  it('identifies the most recent run by startedAt', () => {
    const stats = computeDashboardStats(
      [script()],
      [task({ id: 't1', name: 'Backup' }), task({ id: 't2', name: 'Cleanup' })],
      [
        run({ id: 'r1', taskId: 't1', startedAt: '2026-08-23T01:00:00Z', status: 'success' }),
        run({ id: 'r2', taskId: 't2', startedAt: '2026-08-24T01:00:00Z', status: 'failed' }),
      ],
    )
    expect(stats.lastRunName).toBe('Cleanup')
    expect(stats.lastRunAt).toBe('2026-08-24T01:00:00Z')
    expect(stats.lastRunStatus).toBe('failed')
  })

  it('last run is null when there are no runs', () => {
    const stats = computeDashboardStats([], [], [])
    expect(stats.lastRunAt).toBeNull()
    expect(stats.lastRunName).toBeNull()
    expect(stats.lastRunStatus).toBeNull()
  })

  it('counts runs today based on startedAt', () => {
    const today = new Date()
    const todayStr = today.toISOString()
    const yesterday = new Date(today.getTime() - 86400000).toISOString()
    const stats = computeDashboardStats(
      [],
      [],
      [
        run({ id: 'r1', startedAt: todayStr }),
        run({ id: 'r2', startedAt: todayStr }),
        run({ id: 'r3', startedAt: yesterday }),
      ],
    )
    expect(stats.runsToday).toBe(2)
  })

  it('builds schedule summary grouped by type and sorted by count desc', () => {
    const stats = computeDashboardStats(
      [],
      [
        task({ id: 't1', schedule: { type: 'daily', startAt: '08:00' } }),
        task({ id: 't2', schedule: { type: 'daily', startAt: '09:00' } }),
        task({ id: 't3', schedule: { type: 'weekly', startAt: '08:00', dayOfWeek: 1 } }),
        task({ id: 't4', schedule: { type: 'once', runAt: '2026-08-25T03:00:00' } }),
      ],
      [],
    )
    expect(stats.scheduleSummary).toBe('2 daily · 1 weekly · 1 once')
  })

  it('builds python version summary grouped by version', () => {
    const stats = computeDashboardStats(
      [
        script({ id: 's1', pythonVersion: '3.11' }),
        script({ id: 's2', pythonVersion: '3.11' }),
        script({ id: 's3', pythonVersion: '3.12' }),
        script({ id: 's4' }),
      ],
      [],
      [],
    )
    expect(stats.pythonSummary).toBe('3.11: 3 · 3.12: 1')
  })
})
