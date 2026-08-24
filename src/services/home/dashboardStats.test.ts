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
})
