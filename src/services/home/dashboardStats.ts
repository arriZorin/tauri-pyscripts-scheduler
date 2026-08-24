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
  }
}
