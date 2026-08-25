import { inject, isRef, provide, ref, type InjectionKey, type Ref } from 'vue'
import type { RequirementCheckResult } from '../services/runtimeCheck/types'
import type { ScriptRepository } from '../services/script/ScriptRepository'
import { JsonScriptRepository } from '../services/script/JsonScriptRepository'
import type { TaskRepository } from '../services/task/TaskRepository'
import { JsonTaskRepository } from '../services/task/JsonTaskRepository'
import type { LogRepository } from '../services/log/LogRepository'
import { JsonLogRepository } from '../services/log/JsonLogRepository'
import type { TaskRunRepository } from '../services/task/TaskRunRepository'
import { JsonTaskRunRepository } from '../services/task/JsonTaskRunRepository'
import type { TaskExecutor } from '../services/task/TaskExecutor'
import { TauriTaskExecutor } from '../services/task/TaskExecutor'
import type { FolderRevealer } from '../services/task/FolderRevealer'
import { TauriFolderRevealer } from '../services/task/FolderRevealer'
import type { TaskScheduler } from '../services/task/TaskScheduler'
import { TauriTaskScheduler } from '../services/task/TaskScheduler'
import type { ScriptPicker } from '../services/script/import/ScriptPicker'
import { TauriScriptPicker } from '../services/script/import/ScriptPicker'
import type { FileScanner } from '../services/script/import/FileScanner'
import { TauriFileScanner } from '../services/script/import/FileScanner'
import { AppLogger } from '../services/log/AppLogger'
import { TaskRunRecorder } from '../services/task/TaskRunRecorder'
import { TauriFileStorage } from '../services/shared/TauriFileStorage'
import { TauriVenvSync, type VenvSync } from '../services/script/venvSync'
import { tauriHostHealthService, type HostHealthService } from '../services/home/hostHealth'
import { tauriScriptPathChecker, type ScriptPathChecker } from '../services/script/scriptPathChecker'
import { createRuntimeRequirement } from '../services/runtimeCheck/createRuntimeRequirement'
import type { RuntimeRequirement } from '../services/runtimeCheck/types'

export interface AppContext {
  scriptRepository: ScriptRepository
  taskRepository: TaskRepository
  taskRunRepository: TaskRunRepository
  logRepository: LogRepository
  logger: AppLogger
  taskExecutor: TaskExecutor
  taskScheduler: TaskScheduler
  taskRunRecorder: TaskRunRecorder
  folderRevealer: FolderRevealer
  picker: ScriptPicker
  scanner: FileScanner
  hostHealth: HostHealthService
  scriptPathChecker: ScriptPathChecker
  runtimeRequirement: RuntimeRequirement
  venvSync: VenvSync
  /** Result of the one-time startup runtime check. Reactive ref set by
   *  App.vue — views read this instead of re-probing. */
  runtimeCheckResult: Ref<RequirementCheckResult | null>
}

export const appContextKey: InjectionKey<AppContext> = Symbol('appContext')

export function createAppContext(overrides: Partial<AppContext> = {}): AppContext {
  const storage = new TauriFileStorage()
  const scriptRepository = overrides.scriptRepository ?? new JsonScriptRepository(storage, 'scripts.json')
  const taskRepository = overrides.taskRepository ?? new JsonTaskRepository(storage, 'tasks.json', scriptRepository)
  const taskRunRepository = overrides.taskRunRepository ?? new JsonTaskRunRepository(storage, 'task-runs.json')
  const logRepository = overrides.logRepository ?? new JsonLogRepository(storage, 'logs.json')
  const logger = overrides.logger ?? new AppLogger(logRepository)

  return {
    scriptRepository,
    taskRepository,
    taskRunRepository,
    logRepository,
    logger,
    taskExecutor: overrides.taskExecutor ?? new TauriTaskExecutor(),
    taskScheduler: overrides.taskScheduler ?? new TauriTaskScheduler(),
    taskRunRecorder: overrides.taskRunRecorder ?? new TaskRunRecorder(taskRunRepository),
    folderRevealer: overrides.folderRevealer ?? new TauriFolderRevealer(),
    picker: overrides.picker ?? new TauriScriptPicker(),
    scanner: overrides.scanner ?? new TauriFileScanner(),
    hostHealth: overrides.hostHealth ?? tauriHostHealthService,
    scriptPathChecker: overrides.scriptPathChecker ?? tauriScriptPathChecker,
    runtimeRequirement: overrides.runtimeRequirement ?? createRuntimeRequirement(),
    venvSync: overrides.venvSync ?? new TauriVenvSync(scriptRepository),
    runtimeCheckResult: isRef(overrides.runtimeCheckResult)
      ? overrides.runtimeCheckResult
      : ref(overrides.runtimeCheckResult ?? null),
  }
}

export function provideAppContext(context: AppContext) {
  provide(appContextKey, context)
}

export function useAppContext(): AppContext {
  const context = inject(appContextKey)
  if (!context) {
    throw new Error('AppContext is not provided')
  }
  return context
}