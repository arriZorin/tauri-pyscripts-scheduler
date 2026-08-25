import { createApp, nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TaskView from './TaskView.vue'
import { appContextKey, createAppContext } from '../composables/useAppContext'
import type { Script } from '../models/Script'
import type { Task, TaskInput } from '../models/Task'
import type { TaskRun } from '../models/TaskRun'
import { TaskRunRecorder } from '../services/task/TaskRunRecorder'
import { TauriFolderRevealer } from '../services/task/FolderRevealer'
import type { TaskRunRepository } from '../services/task/TaskRunRepository'
import type { ScriptPathChecker } from '../services/script/scriptPathChecker'
import type { RequirementCheckResult } from '../services/runtimeCheck/types'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
import { invoke } from '@tauri-apps/api/core'

const mockedInvoke = vi.mocked(invoke)

class FakeTaskExecutor {
  calls: string[] = []
  result = 'Task started'
  error: unknown = null

  async run(task: Task) {
    this.calls.push(task.id)
    if (this.error) throw this.error
    return this.result
  }
}

class FakeFolderRevealer {
  reveals: string[] = []
  error: unknown = null

  async reveal(scriptPath: string) {
    if (this.error) throw this.error
    this.reveals.push(scriptPath)
  }
}

class FakeTaskScheduler {
  creates: Task[] = []
  updates: Task[] = []
  deletes: string[] = []
  enabledCalls: { id: string; enabled: boolean }[] = []
  error: unknown = null

  async create(task: Task) {
    if (this.error) throw this.error
    this.creates.push(task)
  }
  async update(task: Task) {
    if (this.error) throw this.error
    this.updates.push(task)
  }
  async delete(taskId: string) {
    if (this.error) throw this.error
    this.deletes.push(taskId)
  }
  async setEnabled(taskId: string, enabled: boolean) {
    if (this.error) throw this.error
    this.enabledCalls.push({ id: taskId, enabled })
  }
}

class FakeLogger {
  records: { source: string; message: string; level: string; durationMs: number | null }[] = []

  async record(source: string, message: string, level = 'info', durationMs: number | null = null) {
    this.records.push({ source, message, level, durationMs })
  }
}

class FakeTaskRunRepository implements TaskRunRepository {
  items: TaskRun[] = []

  async list(): Promise<TaskRun[]> {
    return [...this.items]
  }

  async append(run: TaskRun): Promise<void> {
    this.items.push(run)
  }

  async update(run: TaskRun): Promise<void> {
    const index = this.items.findIndex(existing => existing.id === run.id)
    if (index === -1) throw new Error(`TaskRun with id ${run.id} not found`)
    this.items[index] = run
  }

  async clear(): Promise<void> {
    this.items = []
  }
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'run-1',
    taskId: 'task-1',
    startedAt: '2026-08-14T08:00:00.000Z',
    finishedAt: '2026-08-14T08:00:05.000Z',
    status: 'success',
    exitCode: 0,
    stdout: 'hello',
    stderr: '',
    ...overrides,
  }
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'Daily backup',
    scriptId: script.id,
    interpreter: 'python',
    arguments: [],
    schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' },
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    status: 'scheduled',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const script: Script = {
  id: 'script-1',
  name: 'backup.py',
  path: 'C:/scripts/backup.py',
  type: 'python',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
}

class FakeTaskRepository {
  items: Task[] = []

  async list() { return [...this.items] }
  async get(id: string) { return this.items.find(task => task.id === id) ?? null }
  async create(input: TaskInput) {
    const now = '2024-01-02T00:00:00.000Z'
    const task: Task = { ...input, id: 'task-1', lastRunAt: null, nextRunAt: null, status: input.enabled ? 'scheduled' : 'disabled', createdAt: now, updatedAt: now }
    this.items.push(task)
    return task
  }
  async update(id: string, patch: Partial<Omit<Task, 'id' | 'createdAt' | 'updatedAt'>>) {
    const index = this.items.findIndex(task => task.id === id)
    this.items[index] = { ...this.items[index], ...patch }
    return this.items[index]
  }
  async delete(id: string) { this.items = this.items.filter(task => task.id !== id) }
}

class FakeScriptRepository {
  items: Script[] = [script]

  async list() { return [...this.items] }
}

function mountView(repository: FakeTaskRepository, executor = new FakeTaskExecutor(), scheduler = new FakeTaskScheduler(), logger = new FakeLogger(), runRepository = new FakeTaskRunRepository(), scriptRepository: FakeScriptRepository | null = null, pathChecker: ScriptPathChecker = { exists: async () => true }, runtimeCheck: RequirementCheckResult | null = null, folderRevealer: FakeFolderRevealer | null = null) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(TaskView)
  app.provide(appContextKey, createAppContext({
    taskRepository: repository as never,
    taskExecutor: executor as never,
    taskScheduler: scheduler as never,
    logger: logger as never,
    taskRunRepository: runRepository,
    taskRunRecorder: new TaskRunRecorder(runRepository),
    scriptRepository: (scriptRepository ?? new FakeScriptRepository()) as never,
    scriptPathChecker: pathChecker,
    runtimeCheckResult: ref(runtimeCheck),
    folderRevealer: (folderRevealer ?? new TauriFolderRevealer()) as never,
  }))
  app.mount(container)
  return { container, app, runRepository }
}

async function flush() {
  for (let i = 0; i < 5; i++) {
    await nextTick()
    await Promise.resolve()
  }
}

beforeEach(() => {
  mockedInvoke.mockReset()
  mockedInvoke.mockImplementation((command: string) => {
    // FakeTaskRepository gives every created task the id 'task-1', so treat
    // it as registered by default; missing-task scenarios override below.
    if (command === 'list_scheduled_tasks') return Promise.resolve(['PyscriptScheduler\\task-1'])
    // Unknown commands reject like the unmocked Tauri bridge, so
    // TaskRunRecorder.finalizePending fail-closes and keeps runs 'running'.
    return Promise.reject(`unmocked command: ${command}`)
  })
})

describe('TaskView', () => {
  it('renders an empty state and opens the new task form', async () => {
    const { container, app } = mountView(new FakeTaskRepository())
    await flush()

    expect(container.querySelector('[data-testid="task-empty-state"]')?.textContent).toContain('No tasks')
    ;(container.querySelector('[data-testid="new-task-btn"]') as HTMLElement).click()
    await flush()

    expect(container.querySelector('[data-testid="task-dialog"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="script-select"]')).toBeTruthy()
    const details = container.querySelector('[data-testid="task-details-fieldset"]')
    expect(details).toBeTruthy()
    expect(details?.classList.contains('fieldset')).toBe(true)
    expect(details?.classList.contains('bg-base-200')).toBe(true)
    expect(details?.querySelector('.fieldset-legend')?.textContent).toContain('Task details')
    app.unmount()
  })

  it('pre-fills the interpreter from the system-info python path when creating a task', async () => {
    const repository = new FakeTaskRepository()
    const metResult: RequirementCheckResult = {
      status: 'met', requirementName: 'Python runtime', message: 'Python 3.12.4 found on host.',
      detail: null, resolvedPath: 'C:\\Python312\\python.exe',
    }
    const { container, app } = mountView(repository, new FakeTaskExecutor(), new FakeTaskScheduler(), new FakeLogger(), new FakeTaskRunRepository(), null, { exists: async () => true }, metResult)
    await flush()
    ;(container.querySelector('[data-testid="new-task-btn"]') as HTMLElement).click()
    await flush()
    const interpreter = container.querySelector('[data-testid="interpreter-input"]') as HTMLInputElement
    expect(interpreter.value).toBe('C:\\Python312\\python.exe')
    app.unmount()
  })

  it('keeps the default python interpreter when no python path is available', async () => {
    const repository = new FakeTaskRepository()
    const { container, app } = mountView(repository)
    await flush()
    ;(container.querySelector('[data-testid="new-task-btn"]') as HTMLElement).click()
    await flush()
    const interpreter = container.querySelector('[data-testid="interpreter-input"]') as HTMLInputElement
    expect(interpreter.value).toBe('python')
    app.unmount()
  })

  it('replaces a bare interpreter with the system-info path when editing a task', async () => {
    const repository = new FakeTaskRepository()
    await repository.create({ name: 'Edit me', scriptId: script.id, interpreter: 'python', arguments: [], schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' }, enabled: true })
    const metResult: RequirementCheckResult = {
      status: 'met', requirementName: 'Python runtime', message: 'Python 3.12.4 found on host.',
      detail: null, resolvedPath: 'C:\\Python312\\python.exe',
    }
    const { container, app } = mountView(repository, new FakeTaskExecutor(), new FakeTaskScheduler(), new FakeLogger(), new FakeTaskRunRepository(), null, { exists: async () => true }, metResult)
    await flush()
    ;(container.querySelector('[data-testid="edit-task-task-1"]') as HTMLElement).click()
    await flush()
    const interpreter = container.querySelector('[data-testid="interpreter-input"]') as HTMLInputElement
    expect(interpreter.value).toBe('C:\\Python312\\python.exe')
    app.unmount()
  })

  it('keeps an absolute interpreter when editing, even when a system-info path is available', async () => {
    const repository = new FakeTaskRepository()
    await repository.create({ name: 'Absolute path', scriptId: script.id, interpreter: 'C:\\Custom\\python.exe', arguments: [], schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' }, enabled: true })
    const metResult: RequirementCheckResult = {
      status: 'met', requirementName: 'Python runtime', message: 'Python 3.12.4 found on host.',
      detail: null, resolvedPath: 'C:\\Python312\\python.exe',
    }
    const { container, app } = mountView(repository, new FakeTaskExecutor(), new FakeTaskScheduler(), new FakeLogger(), new FakeTaskRunRepository(), null, { exists: async () => true }, metResult)
    await flush()
    ;(container.querySelector('[data-testid="edit-task-task-1"]') as HTMLElement).click()
    await flush()
    const interpreter = container.querySelector('[data-testid="interpreter-input"]') as HTMLInputElement
    expect(interpreter.value).toBe('C:\\Custom\\python.exe')
    app.unmount()
  })

  it('creates a task from the form and renders it in the list', async () => {
    const repository = new FakeTaskRepository()
    const { container, app } = mountView(repository)
    await flush()
    ;(container.querySelector('[data-testid="new-task-btn"]') as HTMLElement).click()
    await flush()

    const name = container.querySelector('[data-testid="task-name-input"]') as HTMLInputElement
    name.value = 'Daily backup'
    name.dispatchEvent(new Event('input', { bubbles: true }))
    ;(container.querySelector('[data-testid="save-task-btn"]') as HTMLElement).click()
    await flush()

    expect(repository.items[0].name).toBe('Daily backup')
    expect(container.querySelector('[data-testid="task-row-task-1"]')?.textContent).toContain('Daily backup')
    expect(container.querySelector('[data-testid="task-dialog"]')).toBeNull()
    app.unmount()
  })

  it('logs a successful task creation with its name and duration', async () => {
    const repository = new FakeTaskRepository()
    const logger = new FakeLogger()
    const { container, app } = mountView(repository, new FakeTaskExecutor(), new FakeTaskScheduler(), logger)
    await flush()
    ;(container.querySelector('[data-testid="new-task-btn"]') as HTMLElement).click()
    await flush()

    const name = container.querySelector('[data-testid="task-name-input"]') as HTMLInputElement
    name.value = 'Logged task'
    name.dispatchEvent(new Event('input', { bubbles: true }))
    ;(container.querySelector('[data-testid="save-task-btn"]') as HTMLElement).click()
    await flush()

    expect(logger.records[0].source).toBe('task.create')
    expect(logger.records[0].message).toContain('Logged task')
    expect(logger.records[0].message).toContain('repo=')
    expect(logger.records[0].message).toContain('sched=')
    expect(logger.records[0].message).toContain('load=')
    expect(logger.records[0].durationMs).toBeGreaterThanOrEqual(0)
    app.unmount()
  })

  it('logs a failed save as an error with the real message', async () => {
    const repository = new FakeTaskRepository()
    const logger = new FakeLogger()
    const { container, app } = mountView(repository, new FakeTaskExecutor(), new FakeTaskScheduler(), logger)
    await flush()
    ;(container.querySelector('[data-testid="new-task-btn"]') as HTMLElement).click()
    await flush()
    ;(container.querySelector('[data-testid="save-task-btn"]') as HTMLElement).click()
    await flush()

    expect(logger.records[0].source).toBe('task.create')
    expect(logger.records[0].level).toBe('error')
    expect(logger.records[0].message).toContain('Task name is required')
    app.unmount()
  })

  it('refreshes the script list from the repository when opening the new task dialog', async () => {
    const repository = new FakeTaskRepository()
    const scriptRepository = new FakeScriptRepository()
    const { container, app } = mountView(repository, new FakeTaskExecutor(), new FakeTaskScheduler(), new FakeLogger(), new FakeTaskRunRepository(), scriptRepository)
    await flush()

    scriptRepository.items.push({ id: 'script-2', name: 'nightly.py', path: 'C:/scripts/nightly.py', type: 'python', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' })

    ;(container.querySelector('[data-testid="new-task-btn"]') as HTMLElement).click()
    await flush()

    const options = [...container.querySelectorAll('[data-testid="script-select"] option')].map(option => option.textContent)
    expect(options).toContain('nightly.py')
    app.unmount()
  })

  it('refreshes the script list from the repository when opening the edit dialog', async () => {
    const repository = new FakeTaskRepository()
    await repository.create({ name: 'Existing', scriptId: script.id, interpreter: 'python', arguments: [], schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' }, enabled: true })
    const scriptRepository = new FakeScriptRepository()
    const { container, app } = mountView(repository, new FakeTaskExecutor(), new FakeTaskScheduler(), new FakeLogger(), new FakeTaskRunRepository(), scriptRepository)
    await flush()

    scriptRepository.items.push({ id: 'script-2', name: 'nightly.py', path: 'C:/scripts/nightly.py', type: 'python', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' })

    ;(container.querySelector('[data-testid="edit-task-task-1"]') as HTMLElement).click()
    await flush()

    const options = [...container.querySelectorAll('[data-testid="script-select"] option')].map(option => option.textContent)
    expect(options).toContain('nightly.py')
    app.unmount()
  })
})

describe('script selector sorting and duplicate disambiguation', () => {
  it('sorts dropdown options alphabetically by name', async () => {
    const repository = new FakeTaskRepository()
    const scriptRepository = new FakeScriptRepository()
    scriptRepository.items.push(
      { id: 'script-z', name: 'zebra.py', path: 'C:/scripts/zebra.py', type: 'python', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' },
      { id: 'script-a', name: 'alpha.py', path: 'C:/scripts/alpha.py', type: 'python', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' },
    )
    const { container, app } = mountView(repository, new FakeTaskExecutor(), new FakeTaskScheduler(), new FakeLogger(), new FakeTaskRunRepository(), scriptRepository)
    await flush()

    ;(container.querySelector('[data-testid="new-task-btn"]') as HTMLElement).click()
    await flush()

    const options = [...container.querySelectorAll('[data-testid="script-select"] option')].map(option => option.textContent)
    expect(options).toEqual(['alpha.py', 'backup.py', 'zebra.py'])
    app.unmount()
  })

  it('qualifies duplicate script names with their path in the dropdown', async () => {
    const repository = new FakeTaskRepository()
    const scriptRepository = new FakeScriptRepository()
    scriptRepository.items.push(
      { id: 'script-dup-1', name: 'backup.py', path: 'D:/other/backup.py', type: 'python', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' },
    )
    const { container, app } = mountView(repository, new FakeTaskExecutor(), new FakeTaskScheduler(), new FakeLogger(), new FakeTaskRunRepository(), scriptRepository)
    await flush()

    ;(container.querySelector('[data-testid="new-task-btn"]') as HTMLElement).click()
    await flush()

    const options = [...container.querySelectorAll('[data-testid="script-select"] option')].map(option => option.textContent)
    expect(options).toContain('backup.py — C:/scripts/backup.py')
    expect(options).toContain('backup.py — D:/other/backup.py')
    expect(options).not.toContain('backup.py')
    app.unmount()
  })

  it('shows path-qualified script labels in the task table Script column for duplicates', async () => {
    const repository = new FakeTaskRepository()
    await repository.create({ name: 'Dup task', scriptId: 'script-dup-1', interpreter: 'python', arguments: [], schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' }, enabled: true })
    const scriptRepository = new FakeScriptRepository()
    scriptRepository.items.push(
      { id: 'script-dup-1', name: 'backup.py', path: 'D:/other/backup.py', type: 'python', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' },
    )
    const { container, app } = mountView(repository, new FakeTaskExecutor(), new FakeTaskScheduler(), new FakeLogger(), new FakeTaskRunRepository(), scriptRepository)
    await flush()

    const row = container.querySelector('[data-testid="task-row-task-1"]')
    expect(row?.textContent).toContain('backup.py — D:/other/backup.py')
    app.unmount()
  })
})

it('edits, toggles, and deletes a task through row actions', async () => {
  const repository = new FakeTaskRepository()
  await repository.create({ name: 'Existing', scriptId: script.id, interpreter: 'python', arguments: [], schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' }, enabled: true })
  const { container, app } = mountView(repository)
  await flush()

  ;(container.querySelector('[data-testid="edit-task-task-1"]') as HTMLElement).click()
  await flush()
  const name = container.querySelector('[data-testid="task-name-input"]') as HTMLInputElement
  name.value = 'Updated'
  name.dispatchEvent(new Event('input', { bubbles: true }))
  ;(container.querySelector('[data-testid="save-task-btn"]') as HTMLElement).click()
  await flush()
  expect(repository.items[0].name).toBe('Updated')

  ;(container.querySelector('[data-testid="toggle-task-task-1"]') as HTMLElement).click()
  await flush()
  expect(repository.items[0].enabled).toBe(false)

  ;(container.querySelector('[data-testid="delete-task-task-1"]') as HTMLElement).click()
  await nextTick()
  ;(container.querySelector('[data-testid="confirm-task-delete-btn"]') as HTMLElement).click()
  await flush()
  expect(repository.items).toHaveLength(0)
  app.unmount()
})

it('runs a task now and shows the executor result', async () => {
  const repository = new FakeTaskRepository()
  await repository.create({ name: 'Run me', scriptId: script.id, interpreter: 'python', arguments: [], schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' }, enabled: true })
  const executor = new FakeTaskExecutor()
  const { container, app } = mountView(repository, executor)
  await flush()

  ;(container.querySelector('[data-testid="run-task-task-1"]') as HTMLElement).click()
  await flush()

  expect(executor.calls).toEqual(['task-1'])
  expect(container.querySelector('[data-testid="task-operation-result"]')?.textContent).toContain('Task started')
  app.unmount()
})

it('reveals the script folder via the Open Folder button', async () => {
  const repository = new FakeTaskRepository()
  await repository.create({ name: 'Reveal me', scriptId: script.id, interpreter: 'python', arguments: [], schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' }, enabled: true })
  const revealer = new FakeFolderRevealer()
  const { container, app } = mountView(repository, new FakeTaskExecutor(), new FakeTaskScheduler(), new FakeLogger(), new FakeTaskRunRepository(), null, { exists: async () => true }, null, revealer)
  await flush()

  ;(container.querySelector('[data-testid="open-folder-task-task-1"]') as HTMLElement).click()
  await flush()

  expect(revealer.reveals).toEqual(['C:/scripts/backup.py'])
  app.unmount()
})

it('shows an error banner when opening the folder fails', async () => {
  const repository = new FakeTaskRepository()
  await repository.create({ name: 'Reveal me', scriptId: script.id, interpreter: 'python', arguments: [], schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' }, enabled: true })
  const revealer = new FakeFolderRevealer()
  revealer.error = 'boom'
  const { container, app } = mountView(repository, new FakeTaskExecutor(), new FakeTaskScheduler(), new FakeLogger(), new FakeTaskRunRepository(), null, { exists: async () => true }, null, revealer)
  await flush()

  ;(container.querySelector('[data-testid="open-folder-task-task-1"]') as HTMLElement).click()
  await flush()

  expect(container.querySelector('[data-testid="task-operation-error"]')?.textContent).toContain('boom')
  app.unmount()
})

it('shows the real string error when running a task fails', async () => {
  const repository = new FakeTaskRepository()
  await repository.create({ name: 'Run me', scriptId: script.id, interpreter: 'python', arguments: [], schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' }, enabled: true })
  const executor = new FakeTaskExecutor()
  executor.error = 'ERROR: The system cannot find the file specified.'
  const { container, app } = mountView(repository, executor)
  await flush()

  ;(container.querySelector('[data-testid="run-task-task-1"]') as HTMLElement).click()
  await flush()

  expect(container.querySelector('[data-testid="task-operation-error"]')?.textContent).toContain('The system cannot find the file specified')
  app.unmount()
})

it('registers a new task with the scheduler after saving', async () => {
  const repository = new FakeTaskRepository()
  const scheduler = new FakeTaskScheduler()
  const { container, app } = mountView(repository, new FakeTaskExecutor(), scheduler)
  await flush()
  ;(container.querySelector('[data-testid="new-task-btn"]') as HTMLElement).click()
  await flush()

  const name = container.querySelector('[data-testid="task-name-input"]') as HTMLInputElement
  name.value = 'Daily backup'
  name.dispatchEvent(new Event('input', { bubbles: true }))
  ;(container.querySelector('[data-testid="save-task-btn"]') as HTMLElement).click()
  await flush()

  expect(scheduler.creates).toHaveLength(1)
  expect(scheduler.creates[0].id).toBe('task-1')
  expect(scheduler.creates[0].scriptId).toBe('script-1')
  app.unmount()
})

it('resyncs the scheduler when editing a task', async () => {
  const repository = new FakeTaskRepository()
  await repository.create({ name: 'Existing', scriptId: script.id, interpreter: 'python', arguments: [], schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' }, enabled: true })
  const scheduler = new FakeTaskScheduler()
  const { container, app } = mountView(repository, new FakeTaskExecutor(), scheduler)
  await flush()

  ;(container.querySelector('[data-testid="edit-task-task-1"]') as HTMLElement).click()
  await flush()
  const name = container.querySelector('[data-testid="task-name-input"]') as HTMLInputElement
  name.value = 'Updated'
  name.dispatchEvent(new Event('input', { bubbles: true }))
  ;(container.querySelector('[data-testid="save-task-btn"]') as HTMLElement).click()
  await flush()

  expect(scheduler.updates).toHaveLength(1)
  expect(scheduler.updates[0].id).toBe('task-1')
  expect(scheduler.updates[0].name).toBe('Updated')
  app.unmount()
})

it('syncs enable state changes to the scheduler', async () => {
  const repository = new FakeTaskRepository()
  await repository.create({ name: 'Existing', scriptId: script.id, interpreter: 'python', arguments: [], schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' }, enabled: true })
  const scheduler = new FakeTaskScheduler()
  const logger = new FakeLogger()
  const { container, app } = mountView(repository, new FakeTaskExecutor(), scheduler, logger)
  await flush()

  ;(container.querySelector('[data-testid="toggle-task-task-1"]') as HTMLElement).click()
  await flush()

  expect(scheduler.enabledCalls).toEqual([{ id: 'task-1', enabled: false }])
  expect(logger.records[0].message).toContain('update=')
  expect(logger.records[0].message).toContain('set=')
  expect(logger.records[0].message).toContain('load=')
  app.unmount()
})

it('removes the scheduled task when deleting a task', async () => {
  const repository = new FakeTaskRepository()
  await repository.create({ name: 'Existing', scriptId: script.id, interpreter: 'python', arguments: [], schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' }, enabled: true })
  const scheduler = new FakeTaskScheduler()
  const { container, app } = mountView(repository, new FakeTaskExecutor(), scheduler)
  await flush()

  ;(container.querySelector('[data-testid="delete-task-task-1"]') as HTMLElement).click()
  await nextTick()
  ;(container.querySelector('[data-testid="confirm-task-delete-btn"]') as HTMLElement).click()
  await flush()

  expect(scheduler.deletes).toEqual(['task-1'])
  app.unmount()
})

it('logs a successful run with its duration', async () => {
  const repository = new FakeTaskRepository()
  await repository.create({ name: 'Run me', scriptId: script.id, interpreter: 'python', arguments: [], schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' }, enabled: true })
  const logger = new FakeLogger()
  const { container, app } = mountView(repository, new FakeTaskExecutor(), new FakeTaskScheduler(), logger)
  await flush()

  ;(container.querySelector('[data-testid="run-task-task-1"]') as HTMLElement).click()
  await flush()

  expect(logger.records).toHaveLength(1)
  expect(logger.records[0].source).toBe('task.run')
  expect(logger.records[0].level).toBe('info')
  expect(logger.records[0].message).toContain('Task started')
  expect(logger.records[0].durationMs).toBeGreaterThanOrEqual(0)
  app.unmount()
})

it('logs a failed run as an error with the real message', async () => {
  const repository = new FakeTaskRepository()
  await repository.create({ name: 'Run me', scriptId: script.id, interpreter: 'python', arguments: [], schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' }, enabled: true })
  const executor = new FakeTaskExecutor()
  executor.error = 'ERROR: The system cannot find the file specified.'
  const logger = new FakeLogger()
  const { container, app } = mountView(repository, executor, new FakeTaskScheduler(), logger)
  await flush()

  ;(container.querySelector('[data-testid="run-task-task-1"]') as HTMLElement).click()
  await flush()

  expect(logger.records).toHaveLength(1)
  expect(logger.records[0].level).toBe('error')
  expect(logger.records[0].message).toContain('The system cannot find the file specified')
  app.unmount()
})

it('logs enable/disable toggles with the new state and duration', async () => {
  const repository = new FakeTaskRepository()
  await repository.create({ name: 'Existing', scriptId: script.id, interpreter: 'python', arguments: [], schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' }, enabled: true })
  const logger = new FakeLogger()
  const { container, app } = mountView(repository, new FakeTaskExecutor(), new FakeTaskScheduler(), logger)
  await flush()

  ;(container.querySelector('[data-testid="toggle-task-task-1"]') as HTMLElement).click()
  await flush()
  ;(container.querySelector('[data-testid="toggle-task-task-1"]') as HTMLElement).click()
  await flush()

  expect(logger.records).toHaveLength(2)
  expect(logger.records[0].source).toBe('task.toggle')
  expect(logger.records[0].level).toBe('info')
  expect(logger.records[0].message).toContain('Existing')
  expect(logger.records[0].message).toContain('disabled')
  expect(logger.records[0].durationMs).toBeGreaterThanOrEqual(0)
  expect(logger.records[1].message).toContain('enabled')
  app.unmount()
})

it('shows an empty execution history panel', async () => {
  const { container, app } = mountView(new FakeTaskRepository())
  await flush()

  expect(container.querySelector('[data-testid="runs-empty-state"]')?.textContent).toContain('No runs')
  expect(container.querySelector('[data-testid="run-filter-all"]')).toBeTruthy()
  expect(container.querySelector('[data-testid="run-filter-success"]')).toBeTruthy()
  expect(container.querySelector('[data-testid="run-filter-failed"]')).toBeTruthy()
  expect(container.querySelector('[data-testid="runs-clear-btn"]')).toBeTruthy()
  app.unmount()
})

it('renders run history newest first with status, exit code, and output', async () => {
  const runRepository = new FakeTaskRunRepository()
  await runRepository.append(run({ id: 'run-1', startedAt: '2026-08-14T08:00:00.000Z' }))
  await runRepository.append(run({ id: 'run-2', status: 'failed', exitCode: 2, stderr: 'boom', startedAt: '2026-08-15T08:00:00.000Z' }))
  await runRepository.append(run({ id: 'run-3', status: 'running', finishedAt: null, startedAt: '2026-08-16T08:00:00.000Z' }))
  const { container, app } = mountView(new FakeTaskRepository(), new FakeTaskExecutor(), new FakeTaskScheduler(), new FakeLogger(), runRepository)
  await flush()

  const rows = Array.from(container.querySelectorAll('[data-testid^="run-row-"]'))
  expect(rows).toHaveLength(3)
  expect(rows[0]?.getAttribute('data-testid')).toBe('run-row-run-3')
  expect(rows[1]?.getAttribute('data-testid')).toBe('run-row-run-2')
  expect(rows[2]?.getAttribute('data-testid')).toBe('run-row-run-1')
  expect(container.querySelector('[data-testid="run-row-run-2"]')?.textContent).toContain('failed')
  expect(container.querySelector('[data-testid="run-row-run-2"]')?.textContent).toContain('2')
  expect(container.querySelector('[data-testid="run-row-run-2"]')?.textContent).toContain('boom')
  expect(container.querySelector('[data-testid="run-row-run-3"]')?.textContent).toContain('running')
  app.unmount()
})

it('clamps run output to five lines with an ellipsis marker', async () => {
  const runRepository = new FakeTaskRunRepository()
  await runRepository.append(run({ id: 'run-long', status: 'success', exitCode: 0, stderr: 'line1\nline2\nline3\nline4\nline5\nline6\nline7' }))
  await runRepository.append(run({ id: 'run-short', status: 'success', exitCode: 0, stderr: 'one\ntwo' }))
  const { container, app } = mountView(new FakeTaskRepository(), new FakeTaskExecutor(), new FakeTaskScheduler(), new FakeLogger(), runRepository)
  await flush()

  const long = container.querySelector('[data-testid="run-row-run-long"]')?.textContent
  expect(long).toContain('line1')
  expect(long).toContain('line5')
  expect(long).toContain('…')
  expect(long).not.toContain('line6')
  const short = container.querySelector('[data-testid="run-row-run-short"]')?.textContent
  expect(short).toContain('one')
  expect(short).toContain('two')
  expect(short).not.toContain('…')
  app.unmount()
})

it('filters run history by success and failure', async () => {
  const runRepository = new FakeTaskRunRepository()
  await runRepository.append(run({ id: 'run-1', status: 'success' }))
  await runRepository.append(run({ id: 'run-2', status: 'failed', exitCode: 2, stderr: 'boom' }))
  const { container, app } = mountView(new FakeTaskRepository(), new FakeTaskExecutor(), new FakeTaskScheduler(), new FakeLogger(), runRepository)
  await flush()

  ;(container.querySelector('[data-testid="run-filter-failed"]') as HTMLElement).click()
  await nextTick()
  let rows = Array.from(container.querySelectorAll('[data-testid^="run-row-"]'))
  expect(rows).toHaveLength(1)
  expect(rows[0]?.getAttribute('data-testid')).toBe('run-row-run-2')

  ;(container.querySelector('[data-testid="run-filter-success"]') as HTMLElement).click()
  await nextTick()
  rows = Array.from(container.querySelectorAll('[data-testid^="run-row-"]'))
  expect(rows).toHaveLength(1)
  expect(rows[0]?.getAttribute('data-testid')).toBe('run-row-run-1')

  ;(container.querySelector('[data-testid="run-filter-all"]') as HTMLElement).click()
  await nextTick()
  expect(Array.from(container.querySelectorAll('[data-testid^="run-row-"]'))).toHaveLength(2)
  app.unmount()
})

it('clears run history through the confirmation dialog', async () => {
  const runRepository = new FakeTaskRunRepository()
  await runRepository.append(run({ id: 'run-1' }))
  const { container, app } = mountView(new FakeTaskRepository(), new FakeTaskExecutor(), new FakeTaskScheduler(), new FakeLogger(), runRepository)
  await flush()

  ;(container.querySelector('[data-testid="runs-clear-btn"]') as HTMLElement).click()
  await nextTick()
  expect(container.querySelector('[data-testid="runs-clear-dialog"]')).toBeTruthy()

  ;(container.querySelector('[data-testid="confirm-runs-clear-btn"]') as HTMLElement).click()
  await flush()

  expect(runRepository.items).toHaveLength(0)
  expect(container.querySelector('[data-testid="runs-empty-state"]')).toBeTruthy()
  app.unmount()
})

it('cancelling the clear dialog keeps run history', async () => {
  const runRepository = new FakeTaskRunRepository()
  await runRepository.append(run({ id: 'run-1' }))
  const { container, app } = mountView(new FakeTaskRepository(), new FakeTaskExecutor(), new FakeTaskScheduler(), new FakeLogger(), runRepository)
  await flush()

  ;(container.querySelector('[data-testid="runs-clear-btn"]') as HTMLElement).click()
  await nextTick()
  ;(container.querySelector('[data-testid="cancel-runs-clear-btn"]') as HTMLElement).click()
  await flush()

  expect(runRepository.items).toHaveLength(1)
  expect(container.querySelector('[data-testid="runs-clear-dialog"]')).toBeNull()
  app.unmount()
})

it('records a running run when Run Now succeeds', async () => {
  const runRepository = new FakeTaskRunRepository()
  const repository = new FakeTaskRepository()
  await repository.create({ name: 'Run me', scriptId: script.id, interpreter: 'python', arguments: [], schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' }, enabled: true })
  const { container, app } = mountView(repository, new FakeTaskExecutor(), new FakeTaskScheduler(), new FakeLogger(), runRepository)
  await flush()

  ;(container.querySelector('[data-testid="run-task-task-1"]') as HTMLElement).click()
  await flush()

  expect(runRepository.items).toHaveLength(1)
  expect(runRepository.items[0]).toMatchObject({ taskId: 'task-1', status: 'running' })
  app.unmount()
})

it('disables Run Now for disabled tasks and does not invoke the executor', async () => {
  const runRepository = new FakeTaskRunRepository()
  const repository = new FakeTaskRepository()
  await repository.create({ name: 'Disabled task', scriptId: script.id, interpreter: 'python', arguments: [], schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' }, enabled: false })
  const executor = new FakeTaskExecutor()
  const { container, app } = mountView(repository, executor, new FakeTaskScheduler(), new FakeLogger(), runRepository)
  await flush()

  const runButton = container.querySelector('[data-testid="run-task-task-1"]') as HTMLButtonElement
  expect(runButton.disabled).toBe(true)
  runButton.click()
  await flush()

  expect(executor.calls).toEqual([])
  expect(runRepository.items).toHaveLength(0)
  app.unmount()
})

it('defaults the schedule start datetime to today when creating a task', async () => {
  const repository = new FakeTaskRepository()
  const { container, app } = mountView(repository)
  await flush()
  ;(container.querySelector('[data-testid="new-task-btn"]') as HTMLElement).click()
  await flush()

  const input = container.querySelector('[data-testid="start-datetime-input"]') as HTMLInputElement
  expect(input).toBeTruthy()
  expect(input.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)

  const name = container.querySelector('[data-testid="task-name-input"]') as HTMLInputElement
  name.value = 'Start dated task'
  name.dispatchEvent(new Event('input', { bubbles: true }))
  ;(container.querySelector('[data-testid="save-task-btn"]') as HTMLElement).click()
  await flush()

  const saved = repository.items[0].schedule
  expect(saved.type).toBe('daily')
  if (saved.type === 'daily') expect(saved.startAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/)
  app.unmount()
})

it('applies a picked start datetime to the task schedule', async () => {
  const repository = new FakeTaskRepository()
  const { container, app } = mountView(repository)
  await flush()
  ;(container.querySelector('[data-testid="new-task-btn"]') as HTMLElement).click()
  await flush()

  const input = container.querySelector('[data-testid="start-datetime-input"]') as HTMLInputElement
  input.value = '2026-09-01T14:45'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()

  const name = container.querySelector('[data-testid="task-name-input"]') as HTMLInputElement
  name.value = 'Picked date task'
  name.dispatchEvent(new Event('input', { bubbles: true }))
  ;(container.querySelector('[data-testid="save-task-btn"]') as HTMLElement).click()
  await flush()

  const saved = repository.items[0].schedule
  expect(saved.type).toBe('daily')
  if (saved.type === 'daily') expect(saved.startAt).toBe('2026-09-01T14:45:00')
  app.unmount()
})

it('edits once schedule run-at datetime', async () => {
  const repository = new FakeTaskRepository()
  const { container, app } = mountView(repository)
  await flush()
  ;(container.querySelector('[data-testid="new-task-btn"]') as HTMLElement).click()
  await flush()

  const typeSelect = container.querySelector('[data-testid="schedule-type-select"]') as HTMLSelectElement
  typeSelect.value = 'once'
  typeSelect.dispatchEvent(new Event('change', { bubbles: true }))
  await nextTick()

  const runAt = container.querySelector('[data-testid="run-at-input"]') as HTMLInputElement
  expect(runAt).toBeTruthy()
  runAt.value = '2026-09-05T09:30'
  runAt.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()

  const name = container.querySelector('[data-testid="task-name-input"]') as HTMLInputElement
  name.value = 'Once task'
  name.dispatchEvent(new Event('input', { bubbles: true }))
  ;(container.querySelector('[data-testid="save-task-btn"]') as HTMLElement).click()
  await flush()

  const saved = repository.items[0].schedule
  expect(saved.type).toBe('once')
  if (saved.type === 'once') expect(saved.runAt).toBe('2026-09-05T09:30:00')
  app.unmount()
})

it('edits interval every and unit', async () => {
  const repository = new FakeTaskRepository()
  const { container, app } = mountView(repository)
  await flush()
  ;(container.querySelector('[data-testid="new-task-btn"]') as HTMLElement).click()
  await flush()

  const typeSelect = container.querySelector('[data-testid="schedule-type-select"]') as HTMLSelectElement
  typeSelect.value = 'interval'
  typeSelect.dispatchEvent(new Event('change', { bubbles: true }))
  await nextTick()

  const every = container.querySelector('[data-testid="interval-every-input"]') as HTMLInputElement
  expect(every).toBeTruthy()
  every.value = '30'
  every.dispatchEvent(new Event('input', { bubbles: true }))
  const unit = container.querySelector('[data-testid="interval-unit-select"]') as HTMLSelectElement
  const unitOptions = [...unit.options].map(option => option.value)
  expect(unitOptions).toEqual(['minutes', 'hours', 'days', 'weeks', 'months'])
  unit.value = 'days'
  unit.dispatchEvent(new Event('change', { bubbles: true }))
  await nextTick()

  const name = container.querySelector('[data-testid="task-name-input"]') as HTMLInputElement
  name.value = 'Interval task'
  name.dispatchEvent(new Event('input', { bubbles: true }))
  ;(container.querySelector('[data-testid="save-task-btn"]') as HTMLElement).click()
  await flush()

  const saved = repository.items[0].schedule
  expect(saved.type).toBe('interval')
  if (saved.type === 'interval') {
    expect(saved.every).toBe(30)
    expect(saved.unit).toBe('days')
  }
  app.unmount()
})

it('edits weekly day of week', async () => {
  const repository = new FakeTaskRepository()
  const { container, app } = mountView(repository)
  await flush()
  ;(container.querySelector('[data-testid="new-task-btn"]') as HTMLElement).click()
  await flush()

  const typeSelect = container.querySelector('[data-testid="schedule-type-select"]') as HTMLSelectElement
  typeSelect.value = 'weekly'
  typeSelect.dispatchEvent(new Event('change', { bubbles: true }))
  await nextTick()

  const dayOfWeek = container.querySelector('[data-testid="day-of-week-select"]') as HTMLSelectElement
  expect(dayOfWeek).toBeTruthy()
  dayOfWeek.value = '5'
  dayOfWeek.dispatchEvent(new Event('change', { bubbles: true }))
  await nextTick()

  const name = container.querySelector('[data-testid="task-name-input"]') as HTMLInputElement
  name.value = 'Weekly task'
  name.dispatchEvent(new Event('input', { bubbles: true }))
  ;(container.querySelector('[data-testid="save-task-btn"]') as HTMLElement).click()
  await flush()

  const saved = repository.items[0].schedule
  expect(saved.type).toBe('weekly')
  if (saved.type === 'weekly') expect(saved.dayOfWeek).toBe(5)
  app.unmount()
})

it('records a failed run when Run Now errors', async () => {
  const runRepository = new FakeTaskRunRepository()
  const repository = new FakeTaskRepository()
  await repository.create({ name: 'Run me', scriptId: script.id, interpreter: 'python', arguments: [], schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' }, enabled: true })
  const executor = new FakeTaskExecutor()
  executor.error = 'ERROR: The system cannot find the file specified.'
  const { container, app } = mountView(repository, executor, new FakeTaskScheduler(), new FakeLogger(), runRepository)
  await flush()

  ;(container.querySelector('[data-testid="run-task-task-1"]') as HTMLElement).click()
  await flush()

  expect(runRepository.items).toHaveLength(1)
  expect(runRepository.items[0]).toMatchObject({ taskId: 'task-1', status: 'failed' })
  expect(runRepository.items[0].stderr).toContain('The system cannot find the file specified')
  app.unmount()
})

it('shows a reconcile banner when tasks are missing or orphaned', async () => {
  const repository = new FakeTaskRepository()
  await repository.create({ name: 'Registered', scriptId: script.id, interpreter: 'python', arguments: [], schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' }, enabled: true })
  await repository.create({ name: 'Missing', scriptId: script.id, interpreter: 'python', arguments: [], schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' }, enabled: true })
  // FakeTaskRepository gives every created task id 'task-1', so the
  // 'PyscriptScheduler\task-1' registration matches BOTH → 0 missing, 1 orphan.
  mockedInvoke.mockImplementation((command: string) => {
    if (command === 'list_scheduled_tasks') return Promise.resolve(['PyscriptScheduler\\task-1', 'PyscriptScheduler\\task-orphan'])
    return Promise.reject(`unmocked command: ${command}`)
  })
  const { container, app } = mountView(repository)
  await flush()

  const banner = container.querySelector('[data-testid="reconcile-banner"]')
  expect(banner).toBeTruthy()
  expect(banner?.textContent).toContain('1 orphaned')
  app.unmount()
})

it('cleans orphaned registrations with the Clean Orphans button', async () => {
  const repository = new FakeTaskRepository()
  await repository.create({ name: 'Registered', scriptId: script.id, interpreter: 'python', arguments: [], schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' }, enabled: true })
  // Stateful registration list: delete_scheduled_task removes the name, so a
  // reload after cleaning sees the orphan gone and the banner clears.
  const registered = ['PyscriptScheduler\\task-1', 'PyscriptScheduler\\task-orphan']
  mockedInvoke.mockImplementation((command: string) => {
    if (command === 'list_scheduled_tasks') return Promise.resolve([...registered])
    return Promise.reject(`unmocked command: ${command}`)
  })
  const scheduler = new FakeTaskScheduler()
  const originalDelete = scheduler.delete.bind(scheduler)
  scheduler.delete = async (taskId: string) => {
    await originalDelete(taskId)
    registered.splice(registered.indexOf(`PyscriptScheduler\\${taskId}`), 1)
  }
  const { container, app } = mountView(repository, new FakeTaskExecutor(), scheduler)
  await flush()

  const button = container.querySelector('[data-testid="clean-orphans-btn"]')
  expect(button).toBeTruthy()
  expect(button?.textContent).toContain('Clean Orphans')
  ;(button as HTMLElement).click()
  await flush()

  expect(scheduler.deletes).toEqual(['task-orphan'])
  expect(container.querySelector('[data-testid="reconcile-banner"]')).toBeNull()
  expect(container.querySelector('[data-testid="task-operation-result"]')?.textContent).toContain('Removed 1 orphaned registration(s).')
  app.unmount()
})

it('repairs missing tasks by re-registering them', async () => {
  const repository = new FakeTaskRepository()
  await repository.create({ name: 'Missing', scriptId: script.id, interpreter: 'python', arguments: [], schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' }, enabled: true })
  // Simulate registration: the scheduler's create() makes the name appear
  // in list_scheduled_tasks, so repair clears the banner.
  const registered: string[] = []
  mockedInvoke.mockImplementation((command: string) => {
    if (command === 'list_scheduled_tasks') return Promise.resolve([...registered])
    return Promise.reject(`unmocked command: ${command}`)
  })
  const scheduler = new FakeTaskScheduler()
  const originalCreate = scheduler.create.bind(scheduler)
  scheduler.create = async (task: Task) => {
    await originalCreate(task)
    registered.push(`PyscriptScheduler\\${task.id}`)
  }
  const { container, app } = mountView(repository, new FakeTaskExecutor(), scheduler)
  await flush()

  expect(container.querySelector('[data-testid="reconcile-banner"]')).toBeTruthy()
  ;(container.querySelector('[data-testid="repair-tasks-btn"]') as HTMLElement).click()
  await flush()

  expect(scheduler.creates).toHaveLength(1)
  expect(scheduler.creates[0].id).toBe('task-1')
  expect(container.querySelector('[data-testid="reconcile-banner"]')).toBeNull()
  app.unmount()
})

it('flags tasks whose script is missing from the scripts list', async () => {
  const repository = new FakeTaskRepository()
  await repository.create({ name: 'Dangling', scriptId: 'gone-script', interpreter: 'python', arguments: [], schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' }, enabled: true })
  const { container, app } = mountView(repository)
  await flush()

  const badge = container.querySelector('[data-testid="task-row-task-1"] [data-testid="script-missing-badge"]')
  expect(badge).toBeTruthy()
  expect(badge?.textContent).toContain('script_missing')
  app.unmount()
})

it('shows a per-row Repair action only for tasks missing from the scheduler', async () => {
  const repository = new FakeTaskRepository()
  repository.items.push(task({ id: 'task-a', name: 'Registered' }))
  repository.items.push(task({ id: 'task-b', name: 'Missing' }))
  mockedInvoke.mockImplementation((command: string) => {
    if (command === 'list_scheduled_tasks') return Promise.resolve(['PyscriptScheduler\\task-a'])
    return Promise.reject(`unmocked command: ${command}`)
  })
  const { container, app } = mountView(repository)
  await flush()

  const rowA = container.querySelector('[data-testid="task-row-task-a"]')
  const rowB = container.querySelector('[data-testid="task-row-task-b"]')
  // Registered row: enabled status only, full actions, no repair.
  expect(rowA?.querySelector('[data-testid="scheduler-missing-badge"]')).toBeNull()
  expect(rowA?.textContent).toContain('Enabled')
  expect(container.querySelector('[data-testid="repair-task-task-a"]')).toBeNull()
  expect(container.querySelector('[data-testid="edit-task-task-a"]')).toBeTruthy()
  expect(container.querySelector('[data-testid="toggle-task-task-a"]')).toBeTruthy()
  expect(container.querySelector('[data-testid="run-task-task-a"]')).toBeTruthy()
  expect(container.querySelector('[data-testid="delete-task-task-a"]')).toBeTruthy()
  // Missing row: unregistered status only, repair + delete only.
  const badgeB = rowB?.querySelector('[data-testid="scheduler-missing-badge"]')
  expect(badgeB).toBeTruthy()
  expect(badgeB?.textContent).toContain('unregistered')
  expect(rowB?.textContent).not.toContain('Enabled')
  expect(rowB?.textContent).not.toContain('Disabled')
  expect(container.querySelector('[data-testid="repair-task-task-b"]')).toBeTruthy()
  expect(container.querySelector('[data-testid="delete-task-task-b"]')).toBeTruthy()
  expect(container.querySelector('[data-testid="edit-task-task-b"]')).toBeNull()
  expect(container.querySelector('[data-testid="toggle-task-task-b"]')).toBeNull()
  expect(container.querySelector('[data-testid="run-task-task-b"]')).toBeNull()
  app.unmount()
})

it('repairs a single missing task from its row', async () => {
  const repository = new FakeTaskRepository()
  repository.items.push(task({ id: 'task-b', name: 'Missing' }))
  // Simulate registration: the scheduler's create() makes the name appear
  // in list_scheduled_tasks, so the row repair clears the missing flag.
  const registered: string[] = []
  mockedInvoke.mockImplementation((command: string) => {
    if (command === 'list_scheduled_tasks') return Promise.resolve([...registered])
    return Promise.reject(`unmocked command: ${command}`)
  })
  const scheduler = new FakeTaskScheduler()
  const originalCreate = scheduler.create.bind(scheduler)
  scheduler.create = async (created: Task) => {
    await originalCreate(created)
    registered.push(`PyscriptScheduler\\${created.id}`)
  }
  const { container, app } = mountView(repository, new FakeTaskExecutor(), scheduler)
  await flush()

  expect(container.querySelector('[data-testid="repair-task-task-b"]')).toBeTruthy()
  ;(container.querySelector('[data-testid="repair-task-task-b"]') as HTMLElement).click()
  await flush()

  expect(scheduler.creates.map(created => created.id)).toEqual(['task-b'])
  expect(container.querySelector('[data-testid="task-operation-result"]')?.textContent).toContain('Repaired Missing')
  expect(container.querySelector('[data-testid="repair-task-task-b"]')).toBeNull()
  // After repair the task is registered again: status + full actions return.
  expect(container.querySelector('[data-testid="scheduler-missing-badge"]')).toBeNull()
  expect(container.querySelector('[data-testid="edit-task-task-b"]')).toBeTruthy()
  expect(container.querySelector('[data-testid="run-task-task-b"]')).toBeTruthy()
  app.unmount()
})

it('shows script missing as the single status when the script is unresolvable', async () => {
  const repository = new FakeTaskRepository()
  repository.items.push(task({ id: 'task-b', name: 'Broken', scriptId: 'gone' }))
  mockedInvoke.mockImplementation((command: string) => {
    if (command === 'list_scheduled_tasks') return Promise.resolve(['PyscriptScheduler\\task-b'])
    return Promise.reject(`unmocked command: ${command}`)
  })
  const { container, app } = mountView(repository)
  await flush()

  const row = container.querySelector('[data-testid="task-row-task-b"]')
  const badge = row?.querySelector('[data-testid="script-missing-badge"]')
  expect(badge).toBeTruthy()
  expect(badge?.textContent).toContain('script_missing')
  expect(row?.querySelector('[data-testid="scheduler-missing-badge"]')).toBeNull()
  expect(row?.textContent).not.toContain('Enabled')
  expect(row?.textContent).not.toContain('Disabled')
  app.unmount()
})

it('limits actions to edit, disable, and delete when the script is missing but registered', async () => {
  const repository = new FakeTaskRepository()
  repository.items.push(task({ id: 'task-b', name: 'Broken', scriptId: 'gone' }))
  mockedInvoke.mockImplementation((command: string) => {
    if (command === 'list_scheduled_tasks') return Promise.resolve(['PyscriptScheduler\\task-b'])
    return Promise.reject(`unmocked command: ${command}`)
  })
  const { container, app } = mountView(repository)
  await flush()

  expect(container.querySelector('[data-testid="edit-task-task-b"]')).toBeTruthy()
  expect(container.querySelector('[data-testid="disable-task-task-b"]')).toBeTruthy()
  expect(container.querySelector('[data-testid="delete-task-task-b"]')).toBeTruthy()
  expect(container.querySelector('[data-testid="repair-task-task-b"]')).toBeNull()
  expect(container.querySelector('[data-testid="run-task-task-b"]')).toBeNull()
  expect(container.querySelector('[data-testid="toggle-task-task-b"]')).toBeNull()
  app.unmount()
})

it('hides disable when a script-missing task is already disabled', async () => {
  const repository = new FakeTaskRepository()
  repository.items.push(task({ id: 'task-b', name: 'Broken', scriptId: 'gone', enabled: false }))
  mockedInvoke.mockImplementation((command: string) => {
    if (command === 'list_scheduled_tasks') return Promise.resolve(['PyscriptScheduler\\task-b'])
    return Promise.reject(`unmocked command: ${command}`)
  })
  const { container, app } = mountView(repository)
  await flush()

  expect(container.querySelector('[data-testid="edit-task-task-b"]')).toBeTruthy()
  expect(container.querySelector('[data-testid="delete-task-task-b"]')).toBeTruthy()
  expect(container.querySelector('[data-testid="disable-task-task-b"]')).toBeNull()
  expect(container.querySelector('[data-testid="run-task-task-b"]')).toBeNull()
  expect(container.querySelector('[data-testid="repair-task-task-b"]')).toBeNull()
  app.unmount()
})

it('limits actions to edit and delete when the script is missing and unregistered', async () => {
  const repository = new FakeTaskRepository()
  repository.items.push(task({ id: 'task-b', name: 'Broken', scriptId: 'gone' }))
  const { container, app } = mountView(repository)
  await flush()

  expect(container.querySelector('[data-testid="edit-task-task-b"]')).toBeTruthy()
  expect(container.querySelector('[data-testid="delete-task-task-b"]')).toBeTruthy()
  expect(container.querySelector('[data-testid="disable-task-task-b"]')).toBeNull()
  expect(container.querySelector('[data-testid="repair-task-task-b"]')).toBeNull()
  expect(container.querySelector('[data-testid="run-task-task-b"]')).toBeNull()
  app.unmount()
})

it('disables a script-missing registered task from its row', async () => {
  const repository = new FakeTaskRepository()
  repository.items.push(task({ id: 'task-b', name: 'Broken', scriptId: 'gone' }))
  mockedInvoke.mockImplementation((command: string) => {
    if (command === 'list_scheduled_tasks') return Promise.resolve(['PyscriptScheduler\\task-b'])
    return Promise.reject(`unmocked command: ${command}`)
  })
  const scheduler = new FakeTaskScheduler()
  const { container, app } = mountView(repository, new FakeTaskExecutor(), scheduler)
  await flush()

  ;(container.querySelector('[data-testid="disable-task-task-b"]') as HTMLElement).click()
  await flush()

  expect(repository.items[0].enabled).toBe(false)
  expect(scheduler.enabledCalls).toEqual([{ id: 'task-b', enabled: false }])
  expect(container.querySelector('[data-testid="disable-task-task-b"]')).toBeNull()
  app.unmount()
})

it('shows a replacement placeholder in the script selector when editing a script-missing task', async () => {
  const repository = new FakeTaskRepository()
  repository.items.push(task({ id: 'task-b', name: 'Broken', scriptId: 'gone' }))
  const { container, app } = mountView(repository)
  await flush()

  ;(container.querySelector('[data-testid="edit-task-task-b"]') as HTMLElement).click()
  await flush()

  const placeholder = container.querySelector('[data-testid="script-select"] [data-testid="script-missing-placeholder"]')
  expect(placeholder).toBeTruthy()
  expect(placeholder?.textContent).toContain('select a replacement')
  app.unmount()
})

it('shows a broken count and Remove Broken action in the reconcile banner', async () => {
  const repository = new FakeTaskRepository()
  repository.items.push(task({ id: 'task-b', name: 'Broken', scriptId: 'gone' }))
  const { container, app } = mountView(repository)
  await flush()

  const banner = container.querySelector('[data-testid="reconcile-banner"]')
  expect(banner).toBeTruthy()
  expect(banner?.textContent).toContain('1 script_missing')
  expect(container.querySelector('[data-testid="remove-broken-btn"]')).toBeTruthy()
  app.unmount()
})

it('removes broken tasks through the banner confirm dialog', async () => {
  const repository = new FakeTaskRepository()
  repository.items.push(task({ id: 'task-a', name: 'Healthy', scriptId: script.id }))
  repository.items.push(task({ id: 'task-b', name: 'Broken', scriptId: 'gone' }))
  mockedInvoke.mockImplementation((command: string) => {
    if (command === 'list_scheduled_tasks') return Promise.resolve(['PyscriptScheduler\\task-a'])
    return Promise.reject(`unmocked command: ${command}`)
  })
  const scheduler = new FakeTaskScheduler()
  const { container, app } = mountView(repository, new FakeTaskExecutor(), scheduler)
  await flush()

  ;(container.querySelector('[data-testid="remove-broken-btn"]') as HTMLElement).click()
  await nextTick()
  expect(container.querySelector('[data-testid="remove-broken-dialog"]')).toBeTruthy()
  ;(container.querySelector('[data-testid="confirm-remove-broken-btn"]') as HTMLElement).click()
  await flush()

  expect(repository.items.map(task => task.id)).toEqual(['task-a'])
  expect(scheduler.deletes).toEqual(['task-b'])
  expect(container.querySelector('[data-testid="reconcile-banner"]')).toBeNull()
  expect(container.querySelector('[data-testid="task-operation-result"]')?.textContent).toContain('Removed 1 broken')
  app.unmount()
})

it('cancelling the remove-broken dialog keeps broken tasks', async () => {
  const repository = new FakeTaskRepository()
  repository.items.push(task({ id: 'task-b', name: 'Broken', scriptId: 'gone' }))
  const scheduler = new FakeTaskScheduler()
  const { container, app } = mountView(repository, new FakeTaskExecutor(), scheduler)
  await flush()

  ;(container.querySelector('[data-testid="remove-broken-btn"]') as HTMLElement).click()
  await nextTick()
  ;(container.querySelector('[data-testid="cancel-remove-broken-btn"]') as HTMLElement).click()
  await flush()

  expect(repository.items.map(task => task.id)).toEqual(['task-b'])
  expect(scheduler.deletes).toEqual([])
  expect(container.querySelector('[data-testid="remove-broken-dialog"]')).toBeNull()
  app.unmount()
})

it('flags tasks whose script file is missing on disk as script missing', async () => {
  const repository = new FakeTaskRepository()
  repository.items.push(task({ id: 'task-b', name: 'Broken', scriptId: script.id }))
  mockedInvoke.mockImplementation((command: string) => {
    if (command === 'list_scheduled_tasks') return Promise.resolve(['PyscriptScheduler\\task-b'])
    return Promise.reject(`unmocked command: ${command}`)
  })
  const pathChecker = { exists: async (path: string) => path !== script.path }
  const { container, app } = mountView(repository, new FakeTaskExecutor(), new FakeTaskScheduler(), new FakeLogger(), new FakeTaskRunRepository(), null, pathChecker)
  await flush()

  const row = container.querySelector('[data-testid="task-row-task-b"]')
  const badge = row?.querySelector('[data-testid="script-missing-badge"]')
  expect(badge).toBeTruthy()
  expect(badge?.textContent).toContain('script_missing')
  expect(row?.textContent).not.toContain('Enabled')
  expect(container.querySelector('[data-testid="disable-task-task-b"]')).toBeTruthy()
  expect(container.querySelector('[data-testid="run-task-task-b"]')).toBeNull()
  expect(container.querySelector('[data-testid="repair-task-task-b"]')).toBeNull()
  app.unmount()
})

it('excludes scripts whose path is missing from the new-task script selector', async () => {
  const repository = new FakeTaskRepository()
  const scriptRepository = new FakeScriptRepository()
  scriptRepository.items.push({ id: 'script-broken', name: 'broken.py', path: 'C:/scripts/broken.py', type: 'python', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' })
  const pathChecker = { exists: async (path: string) => path !== 'C:/scripts/broken.py' }
  const { container, app } = mountView(repository, new FakeTaskExecutor(), new FakeTaskScheduler(), new FakeLogger(), new FakeTaskRunRepository(), scriptRepository, pathChecker)
  await flush()

  ;(container.querySelector('[data-testid="new-task-btn"]') as HTMLElement).click()
  await flush()

  const options = [...container.querySelectorAll('[data-testid="script-select"] option')].map(option => option.textContent)
  expect(options).toContain('backup.py')
  expect(options.some(option => option?.includes('broken'))).toBe(false)
  const select = container.querySelector('[data-testid="script-select"]') as HTMLSelectElement
  expect(select.value).toBe(script.id)
  app.unmount()
})

it('shows a replacement prompt when editing a task whose script path is missing', async () => {
  const repository = new FakeTaskRepository()
  const brokenScript: Script = { id: 'script-broken', name: 'broken.py', path: 'C:/scripts/broken.py', type: 'python', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' }
  const scriptRepository = new FakeScriptRepository()
  scriptRepository.items.push(brokenScript)
  await repository.create({ name: 'Broken script task', scriptId: brokenScript.id, interpreter: 'python', arguments: [], schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' }, enabled: true })
  const pathChecker = { exists: async (path: string) => path !== brokenScript.path }
  const { container, app } = mountView(repository, new FakeTaskExecutor(), new FakeTaskScheduler(), new FakeLogger(), new FakeTaskRunRepository(), scriptRepository, pathChecker)
  await flush()

  ;(container.querySelector('[data-testid="edit-task-task-1"]') as HTMLElement).click()
  await flush()

  const placeholder = container.querySelector('[data-testid="script-select"] [data-testid="script-missing-placeholder"]')
  expect(placeholder).toBeTruthy()
  expect(placeholder?.textContent).toContain('select a replacement')
  const options = [...container.querySelectorAll('[data-testid="script-select"] option')].map(option => option.textContent)
  expect(options).toContain('backup.py')
  expect(options).not.toContain('broken.py')
  app.unmount()
})

it('blocks saving while the selected script path is missing', async () => {
  const repository = new FakeTaskRepository()
  const brokenScript: Script = { id: 'script-broken', name: 'broken.py', path: 'C:/scripts/broken.py', type: 'python', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' }
  const scriptRepository = new FakeScriptRepository()
  scriptRepository.items.push(brokenScript)
  await repository.create({ name: 'Broken script task', scriptId: brokenScript.id, interpreter: 'python', arguments: [], schedule: { type: 'daily', startAt: '2026-08-14T08:00:00' }, enabled: true })
  const pathChecker = { exists: async (path: string) => path !== brokenScript.path }
  const { container, app } = mountView(repository, new FakeTaskExecutor(), new FakeTaskScheduler(), new FakeLogger(), new FakeTaskRunRepository(), scriptRepository, pathChecker)
  await flush()

  ;(container.querySelector('[data-testid="edit-task-task-1"]') as HTMLElement).click()
  await flush()
  ;(container.querySelector('[data-testid="save-task-btn"]') as HTMLElement).click()
  await flush()

  const dialog = container.querySelector('[data-testid="task-dialog"]')
  expect(dialog?.textContent).toContain('Script is missing')
  expect(repository.items[0].scriptId).toBe(brokenScript.id)
  expect(container.querySelector('[data-testid="task-dialog"]')).toBeTruthy()
  app.unmount()
})

it('repair all skips tasks whose script file is missing on disk', async () => {
  const repository = new FakeTaskRepository()
  repository.items.push(task({ id: 'task-a', name: 'Healthy' }))
  repository.items.push(task({ id: 'task-b', name: 'Broken', scriptId: 'script-2' }))
  const scriptRepo = new FakeScriptRepository()
  scriptRepo.items.push({ id: 'script-2', name: 'gone.py', path: 'C:/scripts/gone.py', type: 'python', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' })
  const pathChecker = { exists: async (path: string) => path !== 'C:/scripts/gone.py' }
  const scheduler = new FakeTaskScheduler()
  const { container, app } = mountView(repository, new FakeTaskExecutor(), scheduler, new FakeLogger(), new FakeTaskRunRepository(), scriptRepo, pathChecker)
  await flush()

  ;(container.querySelector('[data-testid="repair-tasks-btn"]') as HTMLElement).click()
  await flush()

  expect(scheduler.creates.map(created => created.id)).toEqual(['task-a'])
  app.unmount()
})
