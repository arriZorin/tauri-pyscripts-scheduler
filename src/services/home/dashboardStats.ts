import type { Script } from '../../models/Script'
import type { Task } from '../../models/Task'
import type { TaskRun } from '../../models/TaskRun'

/**
 * Aggregated summary metrics for the Home dashboard. Pure so it is
 * unit-testable without repositories or the UI.
 */
export interface DashboardStats {
  totalScripts: number
  usedScripts: number
  unusedScripts: number
  totalTasks: number
  enabledTasks: number
  totalRuns: number
  successRuns: number
  failedRuns: number
  /** Percentage of runs that succeeded (0-100). 0 when there are no runs. */
  successRate: number
  /** ISO string of the next scheduled run, or null. */
  nextRunAt: string | null
  /** Name of the task with the next scheduled run, or null. */
  nextRunName: string | null
  /** ISO string of the most recent run, or null. */
  lastRunAt: string | null
  /** Name of the most recent run's task, or null. */
  lastRunName: string | null
  /** Status of the most recent run, or null. */
  lastRunStatus: string | null
  /** Number of runs whose startedAt is today (local date). */
  runsToday: number
  /** Human-readable schedule type breakdown, e.g. "4 daily · 2 weekly". */
  scheduleSummary: string
  /** Human-readable python version breakdown, e.g. "3.11: 5 · 3.12: 2". */
  pythonSummary: string
}

/** Computes dashboard summary metrics from the current scripts, tasks, and runs. */
export function computeDashboardStats(
  scripts: Script[],
  tasks: Task[],
  runs: TaskRun[],
): DashboardStats {
  const usedScriptIds = new Set(tasks.map(task => task.scriptId))
  const usedScripts = scripts.filter(s => usedScriptIds.has(s.id)).length
  const successRuns = runs.filter(run => run.status === 'success').length
  const failedRuns = runs.filter(run => run.status === 'failed').length
  const totalRuns = successRuns + failedRuns
  const successRate = totalRuns > 0 ? Math.round((successRuns / totalRuns) * 100) : 0

  // Next scheduled run
  const enabled = tasks.filter(t => t.enabled && t.nextRunAt)
  const sorted = [...enabled].sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!))
  const next = sorted[0] ?? null

  // Last run
  const lastRun = [...runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0] ?? null
  const lastTask = lastRun ? tasks.find(t => t.id === lastRun.taskId) : null

  // Runs today
  const today = new Date()
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const runsToday = runs.filter(r => Date.parse(r.startedAt) >= todayStart.getTime()).length

  // Schedule type breakdown
  const scheduleCounts: Record<string, number> = {}
  for (const t of tasks) {
    scheduleCounts[t.schedule.type] = (scheduleCounts[t.schedule.type] ?? 0) + 1
  }
  const scheduleSummary = Object.entries(scheduleCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${count} ${type}`)
    .join(' · ')

  // Python version breakdown
  const pyCounts: Record<string, number> = {}
  for (const s of scripts) {
    const ver = s.pythonVersion ?? '3.11'
    pyCounts[ver] = (pyCounts[ver] ?? 0) + 1
  }
  const pythonSummary = Object.entries(pyCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([ver, count]) => `${ver}: ${count}`)
    .join(' · ')

  return {
    totalScripts: scripts.length,
    usedScripts,
    unusedScripts: scripts.length - usedScripts,
    totalTasks: tasks.length,
    enabledTasks: tasks.filter(task => task.enabled).length,
    totalRuns,
    successRuns,
    failedRuns,
    successRate,
    nextRunAt: next?.nextRunAt ?? null,
    nextRunName: next?.name ?? null,
    lastRunAt: lastRun?.startedAt ?? null,
    lastRunName: lastTask?.name ?? null,
    lastRunStatus: lastRun?.status ?? null,
    runsToday,
    scheduleSummary,
    pythonSummary,
  }
}
