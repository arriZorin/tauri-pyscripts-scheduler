<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AlertIcon from '../components/icons/AlertIcon.vue'
import { useAppContext } from '../composables/useAppContext'
import { useAutoDismiss } from '../composables/useAutoDismiss'
import { scriptDisplayLabels, sortScripts } from '../services/script/scriptLabels'
import type { Script } from '../models/Script'
import type { IntervalUnit, Schedule, Task, TaskInput } from '../models/Task'
import { INTERVAL_UNITS, todayDateString } from '../models/Task'
import type { TaskRun, TaskRunStatus } from '../models/TaskRun'
import { listRegisteredTasks, reconcileTasks, removeOrphanedRegistrations, repairMissingTasks, repairTask } from '../services/task/TaskReconciler'
import type { ReconcileResult } from '../services/task/TaskReconciler'
import { findMissingScriptIds } from '../services/script/scriptReconciliation'
import { errorMessage } from '../services/shared/errorMessage'

const { scriptRepository, taskRepository, taskExecutor, taskScheduler, logger, taskRunRepository, taskRunRecorder, scriptPathChecker, runtimeCheckResult } = useAppContext()
const scripts = ref<Script[]>([])
const sortedScripts = computed(() => sortScripts(scripts.value))
const selectableScripts = computed(() => sortedScripts.value.filter(script => !missingPathScriptIds.value.includes(script.id)))
const scriptLabels = computed(() => scriptDisplayLabels(scripts.value))

function scriptLabelOf(scriptId: string): string {
  return scriptLabels.value.get(scriptId) ?? scriptId
}
const missingPathScriptIds = ref<string[]>([])
const tasks = ref<Task[]>([])
const isEditing = ref(false)
const editingId = ref<string | null>(null)
const deleteTarget = ref<Task | null>(null)
const error = ref('')
const form = ref<TaskInput>(emptyForm())
const runningTaskId = ref<string | null>(null)
const operationResult = ref('')
const operationError = ref('')
useAutoDismiss(operationResult)
useAutoDismiss(operationError)
const runs = ref<TaskRun[]>([])
const runFilter = ref<'all' | 'success' | 'failed'>('all')
const clearRunsTarget = ref(false)
const registeredTasks = ref<string[]>([])
const reconcile = ref<ReconcileResult>({ missing: [], orphaned: [] })
const repairing = ref(false)
const repairingTaskId = ref<string | null>(null)
const cleaningOrphans = ref(false)
const removeBrokenConfirm = ref(false)

const enabledTasks = computed(() => tasks.value.filter(t => t.enabled))
const nextScheduledTask = computed(() => {
  const withNext = enabledTasks.value.filter(t => t.nextRunAt).sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!))
  return withNext[0] ?? null
})
const scheduleBreakdown = computed(() => {
  const counts: Record<string, number> = {}
  for (const t of tasks.value) {
    counts[t.schedule.type] = (counts[t.schedule.type] ?? 0) + 1
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([type, count]) => `${count} ${type}`).join(' · ')
})

async function loadScripts() {
  if (!scriptRepository) return
  try {
    scripts.value = await scriptRepository.list()
  } catch {
    scripts.value = []
  }
  void refreshMissingScriptPaths()
}

async function refreshMissingScriptPaths() {
  try {
    missingPathScriptIds.value = await findMissingScriptIds(scripts.value, scriptPathChecker.exists)
  } catch {
    missingPathScriptIds.value = []
  }
}

function emptyForm(): TaskInput {
  return {
    name: '',
    scriptId: selectableScripts.value[0]?.id ?? '',
    interpreter: 'python',
    arguments: [],
    schedule: { type: 'daily', startAt: `${todayDateString()}T08:00:00` },
    enabled: true,
  }
}

async function load() {
  loadScripts()
  try {
    tasks.value = await taskRepository.list()
  } catch {
    tasks.value = []
  }
  await loadReconcile()
}

async function loadReconcile() {
  try {
    registeredTasks.value = await listRegisteredTasks()
    reconcile.value = reconcileTasks(tasks.value, registeredTasks.value)
  } catch {
    reconcile.value = { missing: [], orphaned: [] }
  }
}

async function repairTasks() {
  if (reconcile.value.missing.length === 0) return
  repairing.value = true
  operationError.value = ''
  try {
    await repairMissingTasks(
      tasks.value.filter(task => !hasMissingScript(task.scriptId)),
      registeredTasks.value,
      scripts.value,
      taskScheduler,
    )
    await load()
    operationResult.value = `Repaired ${reconcile.value.missing.length} task(s).`
  } catch (cause) {
    operationError.value = errorText(cause, 'Failed to repair tasks.')
  } finally {
    repairing.value = false
  }
}

function isTaskMissing(taskId: string): boolean {
  return reconcile.value.missing.some(task => task.id === taskId)
}

async function cleanOrphans() {
  if (reconcile.value.orphaned.length === 0) return
  cleaningOrphans.value = true
  operationError.value = ''
  const count = reconcile.value.orphaned.length
  try {
    await removeOrphanedRegistrations(reconcile.value.orphaned, taskScheduler)
    await load()
    operationResult.value = `Removed ${count} orphaned registration(s).`
  } catch (cause) {
    operationError.value = errorText(cause, 'Failed to clean orphaned registrations.')
  } finally {
    cleaningOrphans.value = false
  }
}

function hasMissingScript(scriptId: string): boolean {
  return !scripts.value.some(script => script.id === scriptId) || missingPathScriptIds.value.includes(scriptId)
}

function brokenTasks(): Task[] {
  return tasks.value.filter(task => hasMissingScript(task.scriptId))
}

async function confirmRemoveBroken() {
  removeBrokenConfirm.value = false
  operationError.value = ''
  try {
    const broken = brokenTasks()
    for (const task of broken) {
      await taskRepository.delete(task.id)
      await taskScheduler.delete(task.id)
    }
    await load()
    operationResult.value = `Removed ${broken.length} broken task(s).`
  } catch (cause) {
    operationError.value = errorText(cause, 'Failed to remove broken tasks.')
  }
}

async function repairTaskRow(task: Task) {
  repairingTaskId.value = task.id
  operationError.value = ''
  try {
    const repaired = await repairTask(task, scripts.value, taskScheduler)
    await load()
    if (repaired) {
      operationResult.value = `Repaired ${task.name}.`
    } else {
      operationError.value = `Cannot repair ${task.name}: script is missing.`
    }
  } catch (cause) {
    operationError.value = errorText(cause, `Failed to repair ${task.name}.`)
  } finally {
    repairingTaskId.value = null
  }
}

async function loadRuns() {
  await taskRunRecorder.finalizePending()
  try {
    runs.value = await taskRunRepository.list()
  } catch {
    runs.value = []
  }
}

function filteredRuns(): TaskRun[] {
  const sorted = [...runs.value].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
  if (runFilter.value === 'success') return sorted.filter(run => run.status === 'success')
  if (runFilter.value === 'failed') return sorted.filter(run => run.status === 'failed')
  return sorted
}

function taskNameOf(taskId: string): string {
  return tasks.value.find(task => task.id === taskId)?.name ?? taskId
}

function runStatusBadge(status: TaskRunStatus): string {
  if (status === 'success') return 'badge-success'
  if (status === 'failed') return 'badge-error'
  return 'badge-info'
}

function runOutput(run: TaskRun): string {
  const output = run.stderr || run.stdout || '-'
  const lines = output.split('\n')
  if (lines.length <= 5) return output
  return `${lines.slice(0, 5).join('\n')}\n…`
}

async function confirmClearRuns() {
  clearRunsTarget.value = false
  await taskRunRecorder.clear()
  await loadRuns()
}

async function openCreate() {
  editingId.value = null
  await loadScripts()
  form.value = emptyForm()
  error.value = ''
  isEditing.value = true
  prefillInterpreterFromSystemInfo()
}

async function openEdit(task: Task) {
  editingId.value = task.id
  await loadScripts()
  form.value = {
    name: task.name,
    scriptId: task.scriptId,
    interpreter: task.interpreter,
    arguments: [...task.arguments],
    schedule: { ...task.schedule } as Schedule,
    enabled: task.enabled,
  }
  error.value = ''
  isEditing.value = true
  // Bare names (e.g. 'python') resolve through PATH to whatever comes first —
  // which can be a different interpreter than the system-info Python. Replace
  // only non-absolute values so stored absolute paths are always respected.
  if (!isAbsoluteWindowsPath(task.interpreter)) {
    prefillInterpreterFromSystemInfo()
  }
}

function isAbsoluteWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value)
}

/**
 * Pre-fills the interpreter with the Python path resolved once at startup
 * (the same one System Info shows) so tasks never silently fall back to a
 * PATH-first `python.exe` that differs from the detected runtime.
 */
function prefillInterpreterFromSystemInfo() {
  const resolvedPath = runtimeCheckResult.value?.resolvedPath
  if (resolvedPath) {
    form.value.interpreter = resolvedPath
  }
}

function closeForm() {
  isEditing.value = false
  editingId.value = null
  error.value = ''
}

function updateScheduleType(type: Schedule['type']) {
  if (type === 'once') form.value.schedule = { type, runAt: `${todayDateString()}T08:00:00` }
  if (type === 'daily') form.value.schedule = { type, startAt: `${todayDateString()}T08:00:00` }
  if (type === 'weekly') form.value.schedule = { type, startAt: `${todayDateString()}T08:00:00`, dayOfWeek: 1 }
  if (type === 'interval') form.value.schedule = { type, startAt: `${todayDateString()}T08:00:00`, every: 1, unit: 'hours' }
}

function onStartDateTimeChange(event: Event) {
  const value = (event.target as { value?: string }).value
  if (!value) return
  const schedule = form.value.schedule
  if (schedule.type === 'once') return
  form.value.schedule = { ...schedule, startAt: `${value}:00` }
}

function scheduleStartDateTime(): string {
  const schedule = form.value.schedule
  if (schedule.type === 'once') return ''
  return schedule.startAt.slice(0, 16)
}

function onRunAtChange(event: Event) {
  const value = (event.target as { value?: string }).value
  if (!value) return
  if (form.value.schedule.type !== 'once') return
  form.value.schedule = { type: 'once', runAt: `${value}:00` }
}

function scheduleRunAt(): string {
  const schedule = form.value.schedule
  return schedule.type === 'once' ? schedule.runAt.slice(0, 16) : ''
}

function onEveryChange(event: Event) {
  const value = Number((event.target as { value?: string }).value)
  const schedule = form.value.schedule
  if (schedule.type !== 'interval' || Number.isNaN(value)) return
  form.value.schedule = { ...schedule, every: value }
}

function onUnitChange(event: Event) {
  const value = (event.target as { value?: string }).value as IntervalUnit
  const schedule = form.value.schedule
  if (schedule.type !== 'interval' || !INTERVAL_UNITS.includes(value)) return
  form.value.schedule = { ...schedule, unit: value }
}

const intervalUnitLabel: Record<IntervalUnit, string> = {
  minutes: 'Minutes',
  hours: 'Hours',
  days: 'Days',
  weeks: 'Weeks',
  months: 'Months',
}

function onDayOfWeekChange(event: Event) {
  const value = Number((event.target as { value?: string }).value)
  const schedule = form.value.schedule
  if (schedule.type !== 'weekly' || value < 0 || value > 6) return
  form.value.schedule = { ...schedule, dayOfWeek: value as 0 | 1 | 2 | 3 | 4 | 5 | 6 }
}

async function save() {
  error.value = ''
  const started = performance.now()
  try {
    if (!form.value.name.trim()) throw new Error('Task name is required')
    if (!form.value.scriptId) throw new Error('Script is required')
    if (missingPathScriptIds.value.includes(form.value.scriptId)) throw new Error('Script is missing — select a replacement')
    if (!form.value.interpreter.trim()) throw new Error('Python interpreter is required')
    const script = scripts.value.find(script => script.id === form.value.scriptId)
    if (!script) throw new Error('Script is required')
    let task: Task
    if (editingId.value) {
      task = await taskRepository.update(editingId.value, form.value)
    } else {
      task = await taskRepository.create(form.value)
    }
    const afterRepo = performance.now()
    if (editingId.value) {
      await taskScheduler.update(task, script)
    } else {
      await taskScheduler.create(task, script)
    }
    const afterScheduler = performance.now()
    await load()
    const afterLoad = performance.now()
    const step = (name: string, at: number) => `${name}=${Math.round(at - started)}ms`
    await logger?.record('task.create', `${editingId.value ? 'update' : 'create'} ${task.name} (${step('repo', afterRepo)} ${step('sched', afterScheduler)} ${step('load', afterLoad)})`, 'info', Math.round(afterLoad - started))
    closeForm()
  } catch (cause) {
    error.value = errorText(cause, 'Failed to save task.')
    await logger?.record('task.create', `save ${form.value.name || 'task'} failed: ${error.value}`, 'error', Math.round(performance.now() - started))
  }
}

async function toggle(task: Task) {
  operationError.value = ''
  const started = performance.now()
  const step = (name: string, at: number) => `${name}=${Math.round(at - started)}ms`
  try {
    const updated = await taskRepository.update(task.id, { enabled: !task.enabled })
    const afterUpdate = performance.now()
    await taskScheduler.setEnabled(updated.id, updated.enabled)
    const afterSet = performance.now()
    await load()
    const afterLoad = performance.now()
    await logger?.record(
      'task.toggle',
      `toggle ${updated.name}: ${updated.enabled ? 'enabled' : 'disabled'} (${step('update', afterUpdate)} ${step('set', afterSet)} ${step('load', afterLoad)})`,
      'info',
      Math.round(afterLoad - started),
    )
  } catch (cause) {
    operationError.value = errorText(cause, 'Failed to update task.')
    await logger?.record('task.toggle', `toggle ${task.name} failed: ${operationError.value}`, 'error', Math.round(performance.now() - started))
  }
}

async function runTask(task: Task) {
  runningTaskId.value = task.id
  operationResult.value = ''
  operationError.value = ''
  const started = performance.now()
  const run = await taskRunRecorder.recordStart(task.id)
  try {
    operationResult.value = await taskExecutor.run(task)
    await logger?.record('task.run', `run ${task.name}: ${operationResult.value}`, 'info', Math.round(performance.now() - started))
    await load()
    await loadRuns()
  } catch (cause) {
    // Run-now errors are the script's own stderr output — preserve it
    // verbatim in the run history rather than rewriting it as guidance.
    const message = rawErrorText(cause, 'Failed to run task.')
    operationError.value = message
    await taskRunRecorder.recordFailure(run, message)
    await logger?.record('task.run', `run ${task.name} failed: ${message}`, 'error', Math.round(performance.now() - started))
  } finally {
    runningTaskId.value = null
  }
}

function requestDelete(task: Task) {
  deleteTarget.value = task
}

function cancelDelete() {
  deleteTarget.value = null
}

async function confirmDelete() {
  if (!deleteTarget.value) return
  operationError.value = ''
  try {
    const target = deleteTarget.value
    await taskRepository.delete(target.id)
    await taskScheduler.delete(target.id)
    deleteTarget.value = null
    await load()
  } catch (cause) {
    operationError.value = errorText(cause, 'Failed to delete task.')
  }
}

function errorText(cause: unknown, fallback: string): string {
  return errorMessage(cause, fallback)
}

function rawErrorText(cause: unknown, fallback: string): string {
  if (cause instanceof Error) return cause.message
  if (typeof cause === 'string' && cause.trim()) return cause
  return fallback
}

function scheduleLabel(schedule: Schedule): string {
  if (schedule.type === 'once') return `Once: ${schedule.runAt}`
  if (schedule.type === 'daily') return `Daily from ${schedule.startAt}`
  if (schedule.type === 'weekly') return `Weekly from ${schedule.startAt}: ${schedule.dayOfWeek}`
  return `Every ${schedule.every} ${schedule.unit} from ${schedule.startAt}`
}

onMounted(() => {
  load()
  loadRuns()
})
</script>

<template>
  <div class="view-container w-full">
    <header class="region header card card-compact bg-base-100 border border-base-200 rounded-box shadow-sm p-0 mb-4">
  <div class="card-body p-4 m-0">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-5 h-5 stroke-current">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <div>
          <h1 class="text-lg font-bold">Scheduled Tasks</h1>
          <p class="text-sm text-base-content/60">Automate script execution on a schedule</p>
        </div>
      </div>
      <button class="btn btn-primary btn-sm" data-testid="new-task-btn" @click="openCreate">New Task</button>
    </div>
    <div class="mt-3 pt-3 border-t border-base-200 flex flex-wrap gap-x-4 gap-y-1 text-xs text-base-content/60">
      <span>{{ tasks.length }} task{{ tasks.length === 1 ? '' : 's' }}</span>
      <span>{{ enabledTasks.length }} enabled · {{ tasks.length - enabledTasks.length }} disabled</span>
      <span v-if="scheduleBreakdown">{{ scheduleBreakdown }}</span>
      <span v-if="nextScheduledTask">Next: <span class="font-medium">{{ nextScheduledTask.name }}</span></span>
    </div>
  </div>
</header>
    <main class="region body card p-4 m-2 rounded border border-gray-300 bg-white min-h-[200px] dark:bg-[#333333] dark:border-[#404040]">
      <div v-if="operationResult" class="alert alert-success mb-3" data-testid="task-operation-result" role="alert"><AlertIcon kind="success" /><span>{{ operationResult }}</span></div>
      <div v-if="operationError" class="alert alert-error mb-3" data-testid="task-operation-error" role="alert"><AlertIcon kind="error" /><span>{{ operationError }}</span></div>
      <div v-if="reconcile.missing.length > 0 || reconcile.orphaned.length > 0 || brokenTasks().length > 0" class="alert alert-warning mb-3" data-testid="reconcile-banner" role="alert">
        <AlertIcon kind="warning" />
        <div class="flex flex-row items-center justify-between w-full gap-2">
          <span>{{ reconcile.missing.length }} task(s) unregistered{{ reconcile.orphaned.length > 0 ? `, ${reconcile.orphaned.length} orphaned registration(s)` : '' }}{{ brokenTasks().length > 0 ? `, ${brokenTasks().length} script_missing` : '' }}</span>
          <div class="flex gap-2">
            <button v-if="brokenTasks().length > 0" class="btn btn-xs btn-error" data-testid="remove-broken-btn" @click="removeBrokenConfirm = true">Remove Broken</button>
            <button v-if="reconcile.missing.length > 0" class="btn btn-xs btn-warning" :disabled="repairing" data-testid="repair-tasks-btn" @click="repairTasks">{{ repairing ? 'Repairing...' : 'Repair All' }}</button>
            <button v-if="reconcile.orphaned.length > 0" class="btn btn-xs btn-warning" :disabled="cleaningOrphans" data-testid="clean-orphans-btn" @click="cleanOrphans">{{ cleaningOrphans ? 'Cleaning...' : 'Clean Orphans' }}</button>
          </div>
        </div>
      </div>
      <div v-if="tasks.length === 0" class="alert alert-info" data-testid="task-empty-state" role="alert"><AlertIcon kind="info" /><span>No tasks yet.</span></div>
      <table v-else class="table table-zebra w-full" data-testid="task-table">
        <thead><tr><th>Name</th><th>Script</th><th>Schedule</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
          <tr v-for="task in tasks" :key="task.id" :data-testid="`task-row-${task.id}`">
            <td>{{ task.name }}</td>
            <td>{{ scriptLabelOf(task.scriptId) }}</td>
            <td>{{ scheduleLabel(task.schedule) }}</td>
            <td><span v-if="hasMissingScript(task.scriptId)" class="badge badge-error" data-testid="script-missing-badge">script_missing</span><span v-else-if="isTaskMissing(task.id)" class="badge badge-warning" data-testid="scheduler-missing-badge">unregistered</span><span v-else class="badge" :class="task.enabled ? 'badge-success' : 'badge-ghost'">{{ task.enabled ? 'Enabled' : 'Disabled' }}</span></td>
            <td><div class="join">
              <template v-if="hasMissingScript(task.scriptId)">
                <button class="btn btn-xs join-item" :data-testid="`edit-task-${task.id}`" @click="openEdit(task)">Edit</button>
                <button v-if="!isTaskMissing(task.id) && task.enabled" class="btn btn-xs join-item" :data-testid="`disable-task-${task.id}`" @click="toggle(task)">Disable</button>
                <button class="btn btn-xs btn-error join-item" :data-testid="`delete-task-${task.id}`" @click="requestDelete(task)">Delete</button>
              </template>
              <template v-else-if="isTaskMissing(task.id)">
                <button class="btn btn-xs btn-warning join-item" :data-testid="`repair-task-${task.id}`" :disabled="repairingTaskId === task.id || repairing" @click="repairTaskRow(task)">{{ repairingTaskId === task.id ? 'Repairing...' : 'Repair' }}</button>
                <button class="btn btn-xs btn-error join-item" :data-testid="`delete-task-${task.id}`" @click="requestDelete(task)">Delete</button>
              </template>
              <template v-else>
                <button class="btn btn-xs join-item" :data-testid="`edit-task-${task.id}`" @click="openEdit(task)">Edit</button>
                <button class="btn btn-xs join-item" :data-testid="`toggle-task-${task.id}`" @click="toggle(task)">{{ task.enabled ? 'Disable' : 'Enable' }}</button>
                <button class="btn btn-xs btn-primary join-item" :data-testid="`run-task-${task.id}`" :disabled="runningTaskId === task.id || !task.enabled" @click="runTask(task)">{{ runningTaskId === task.id ? 'Starting...' : 'Run Now' }}</button>
                <button class="btn btn-xs btn-error join-item" :data-testid="`delete-task-${task.id}`" @click="requestDelete(task)">Delete</button>
              </template>
            </div></td>
          </tr>
        </tbody>
      </table>
      <div class="divider"></div>
      <section class="mt-8" data-testid="run-history-panel">
        <div class="flex flex-row items-center justify-between mb-3">
          <h2 class="text-lg font-semibold">Execution History</h2>
          <div class="join">
            <button class="btn btn-xs join-item" :class="runFilter === 'all' ? 'btn-primary' : ''" data-testid="run-filter-all" @click="runFilter = 'all'">All</button>
            <button class="btn btn-xs join-item" :class="runFilter === 'success' ? 'btn-primary' : ''" data-testid="run-filter-success" @click="runFilter = 'success'">Success</button>
            <button class="btn btn-xs join-item" :class="runFilter === 'failed' ? 'btn-primary' : ''" data-testid="run-filter-failed" @click="runFilter = 'failed'">Failed</button>
          </div>
          <div class="flex gap-2">
            <button class="btn btn-xs btn-error" data-testid="runs-clear-btn" @click="clearRunsTarget = true">Clear History</button>
            <button class="btn btn-xs" data-testid="runs-refresh-btn" @click="loadRuns">Refresh</button>
          </div>
        </div>
        <div v-if="filteredRuns().length === 0" class="alert alert-info" data-testid="runs-empty-state" role="alert"><AlertIcon kind="info" /><span>No runs yet.</span></div>
        <table v-else class="table table-zebra w-full" data-testid="runs-table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Status</th>
              <th>Started</th>
              <th>Finished</th>
              <th>Output</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="run in filteredRuns()" :key="run.id" :data-testid="`run-row-${run.id}`">
              <td>{{ taskNameOf(run.taskId) }}</td>
              <td><span class="badge" :class="runStatusBadge(run.status)">{{ run.status }}</span></td>
              <td>{{ new Date(run.startedAt).toLocaleString() }}</td>
              <td>{{ run.finishedAt ? new Date(run.finishedAt).toLocaleString() : '-' }}</td>
              <td><span class="whitespace-pre-wrap text-xs">{{ runOutput(run) }}</span></td>
            </tr>
          </tbody>
        </table>
      </section>
    </main>
    <footer class="region footer card p-4 m-2 rounded border border-gray-300 bg-gray-100 mt-4 text-center text-sm text-gray-500 dark:bg-[#2f2f2f] dark:border-[#404040] dark:text-[#999999]"><div class="card-body"><p>&copy; 2026 Scripts Management</p></div></footer>

    <dialog v-if="isEditing" class="modal modal-open" data-testid="task-dialog" role="dialog">
      <div class="modal-box">
        <fieldset data-testid="task-details-fieldset" class="fieldset bg-base-200 border-base-300 rounded-box w-full border p-4">
          <legend class="fieldset-legend">Task details</legend>
          <label class="label">Name</label>
          <input v-model="form.name" class="input input-bordered w-full" data-testid="task-name-input" placeholder="Daily backup" />
          <label class="label">Script</label>
          <select v-model="form.scriptId" class="select select-bordered w-full" data-testid="script-select"><option v-if="form.scriptId && (!scripts.some(script => script.id === form.scriptId) || missingPathScriptIds.includes(form.scriptId))" :value="form.scriptId" disabled data-testid="script-missing-placeholder">Script missing — select a replacement</option><option v-for="script in selectableScripts" :key="script.id" :value="script.id" :title="script.path">{{ scriptLabelOf(script.id) }}</option></select>
          <label class="label">Python interpreter</label>
          <input v-model="form.interpreter" class="input input-bordered w-full" data-testid="interpreter-input" placeholder="python" />
          <label class="label">Arguments</label>
          <input :value="form.arguments.join(' ')" class="input input-bordered w-full" data-testid="arguments-input" placeholder="--format json" @input="form.arguments = (($event.target as HTMLInputElement).value.trim() ? ($event.target as HTMLInputElement).value.trim().split(/\s+/) : [])" />
          <label class="label">Schedule</label>
          <select :value="form.schedule.type" class="select select-bordered w-full" data-testid="schedule-type-select" @change="updateScheduleType(($event.target as HTMLSelectElement).value as Schedule['type'])"><option value="once">Once</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="interval">Interval</option></select>

          <template v-if="form.schedule.type === 'once'">
            <label class="label mt-2">Run at</label>
            <input :value="scheduleRunAt()" class="input input-bordered w-full" data-testid="run-at-input" type="datetime-local" @input="onRunAtChange" />
          </template>

          <template v-else>
            <label class="label mt-2">Start date & time</label>
            <input :value="scheduleStartDateTime()" class="input input-bordered w-full" data-testid="start-datetime-input" type="datetime-local" @input="onStartDateTimeChange" />
          </template>

          <template v-if="form.schedule.type === 'weekly'">
            <label class="label mt-2">Day of week</label>
            <select :value="form.schedule.type === 'weekly' ? form.schedule.dayOfWeek : ''" class="select select-bordered w-full" data-testid="day-of-week-select" @change="onDayOfWeekChange">
              <option :value="0">Sunday</option>
              <option :value="1">Monday</option>
              <option :value="2">Tuesday</option>
              <option :value="3">Wednesday</option>
              <option :value="4">Thursday</option>
              <option :value="5">Friday</option>
              <option :value="6">Saturday</option>
            </select>
          </template>

          <template v-if="form.schedule.type === 'interval'">
            <label class="label mt-2">Repeat every</label>
            <div class="flex gap-2">
              <input :value="form.schedule.type === 'interval' ? form.schedule.every : ''" class="input input-bordered w-24" data-testid="interval-every-input" type="number" min="1" @input="onEveryChange" />
              <select :value="form.schedule.type === 'interval' ? form.schedule.unit : 'hours'" class="select select-bordered flex-1" data-testid="interval-unit-select" @change="onUnitChange">
                <option v-for="unit in INTERVAL_UNITS" :key="unit" :value="unit">{{ intervalUnitLabel[unit] }}</option>
              </select>
            </div>
          </template>

          <div v-if="error" class="alert alert-error mt-3" role="alert"><AlertIcon kind="error" /><span>{{ error }}</span></div>
        </fieldset>
        <div class="modal-action"><button class="btn btn-primary" data-testid="save-task-btn" @click="save">Save</button><button class="btn" data-testid="cancel-task-btn" @click="closeForm">Cancel</button></div>
      </div>
    </dialog>

    <dialog v-if="deleteTarget" class="modal modal-open" data-testid="task-delete-dialog" role="dialog">
      <div class="modal-box"><h3 class="text-lg font-bold">Delete Task</h3><p class="py-4">Delete {{ deleteTarget.name }}?</p><div class="modal-action"><button class="btn btn-error" data-testid="confirm-task-delete-btn" @click="confirmDelete">Delete</button><button class="btn" data-testid="cancel-task-delete-btn" @click="cancelDelete">Cancel</button></div></div>
    </dialog>

    <dialog v-if="clearRunsTarget" class="modal modal-open" data-testid="runs-clear-dialog" role="dialog">
      <div class="modal-box"><h3 class="text-lg font-bold">Clear History</h3><p class="py-4">Remove all execution history?</p><div class="modal-action"><button class="btn btn-error" data-testid="confirm-runs-clear-btn" @click="confirmClearRuns">Clear</button><button class="btn" data-testid="cancel-runs-clear-btn" @click="clearRunsTarget = false">Cancel</button></div></div>
    </dialog>

    <dialog v-if="removeBrokenConfirm" class="modal modal-open" data-testid="remove-broken-dialog" role="dialog">
      <div class="modal-box"><h3 class="text-lg font-bold">Remove Broken Tasks</h3><p class="py-4">Remove {{ brokenTasks().length }} task(s) with missing scripts? Their Windows registrations will also be removed.</p><div class="modal-action"><button class="btn btn-error" data-testid="confirm-remove-broken-btn" @click="confirmRemoveBroken">Remove</button><button class="btn" data-testid="cancel-remove-broken-btn" @click="removeBrokenConfirm = false">Cancel</button></div></div>
    </dialog>
  </div>
</template>

<style scoped>
</style>
