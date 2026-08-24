<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useAppContext } from '../composables/useAppContext';
import type { Script } from '../models/Script';
import type { Task } from '../models/Task';
import type { TaskRun } from '../models/TaskRun';
import { computeDashboardStats, type DashboardStats } from '../services/home/dashboardStats';
import type { SystemInfo } from '../services/home/systemInfo';
import type { RequirementCheckResult } from '../services/runtimeCheck/types';

interface Props {
  onNavigate?: (viewId: string) => void;
}

const props = defineProps<Props>();
const onNavigate = props.onNavigate;

const {
  scriptRepository,
  taskRepository,
  taskRunRepository,
  systemInfo: systemInfoService,
  runtimeRequirement,
  runtimeCheckResult,
  logger,
} = useAppContext();

const stats = ref<DashboardStats>({
  totalScripts: 0,
  usedScripts: 0,
  unusedScripts: 0,
  totalTasks: 0,
  enabledTasks: 0,
  totalRuns: 0,
  successRuns: 0,
  failedRuns: 0,
  successRate: 0,
  nextRunAt: null,
  nextRunName: null,
  lastRunAt: null,
  lastRunName: null,
  lastRunStatus: null,
  runsToday: 0,
  scheduleSummary: '',
  pythonSummary: '',
});
const tasks = ref<Task[]>([]);
const recentRuns = ref<TaskRun[]>([]);
const systemInfo = ref<SystemInfo | null>(null);
const loaded = ref(false);
// Runtime result is read from the reactive context ref set once at startup
// (App.vue).  No locator probe runs when this view mounts.
const runtimeResult = computed(() => runtimeCheckResult.value);
const runtimeResolving = ref(false);

async function loadStats() {
  const [scripts, loadedTasks, runs, loadedSystemInfo]: [Script[], Task[], TaskRun[], SystemInfo | null] = await Promise.all([
    scriptRepository.list().catch(() => [] as Script[]),
    taskRepository.list().catch(() => [] as Task[]),
    taskRunRepository.list().catch(() => [] as TaskRun[]),
    systemInfoService.load().catch(() => null),
  ]);
  tasks.value = loadedTasks;
  recentRuns.value = [...runs]
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, 5);
  stats.value = computeDashboardStats(scripts, loadedTasks, runs);
  systemInfo.value = loadedSystemInfo;
  loaded.value = true;
}

async function resolveRuntime() {
  runtimeResolving.value = true;
  try {
    const resolved = await runtimeRequirement.resolve();
    runtimeCheckResult.value = resolved;
    await logger?.record('runtime.resolve',
      resolved.status === 'met' ? `Resolved: ${resolved.message} [${resolved.resolvedPath}]` : `Failed: ${resolved.message}`,
      resolved.status === 'met' ? 'info' : 'error');
  } catch (error) {
    runtimeCheckResult.value = {
      status: 'failed',
      requirementName: 'Python runtime',
      message: 'Resolve failed.',
      detail: error instanceof Error ? error.message : String(error),
      resolvedPath: null,
    };
  } finally {
    runtimeResolving.value = false;
  }
}

function taskName(taskId: string) {
  return tasks.value.find((task) => task.id === taskId)?.name ?? taskId;
}

function formatRunDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : '-';
}

function runtimeStatusLabel(status: RequirementCheckResult['status']): string {
  switch (status) {
    case 'met': return 'Met';
    case 'notMet': return 'Not met';
    case 'deferred': return 'Deferred';
    case 'failed': return 'Failed';
  }
}

function runtimeStatusBadge(status: RequirementCheckResult['status']): string {
  switch (status) {
    case 'met': return 'badge-success';
    case 'notMet': return 'badge-warning';
    case 'deferred': return 'badge-warning';
    case 'failed': return 'badge-error';
  }
}

onMounted(() => {
  loadStats();
});
</script>

<template>
  <div class="view-container w-full">
    <header class="region card header p-4 m-2 rounded border border-gray-300 bg-gray-100 mb-4 dark:bg-[#2f2f2f] dark:border-[#404040]">
      <slot name="header">
        <div class="card-body">
          <h1 class="text-xl font-semibold">Home</h1>
          <p class="text-gray-600">Welcome to the application</p>
        </div>
      </slot>
    </header>
    <main class="region card body p-4 m-2 rounded border border-gray-300 bg-white min-h-[200px] dark:bg-[#333333] dark:border-[#404040]">
      <slot name="body">
        <div class="card-body" data-testid="dashboard">
          <div class="stats shadow w-full" data-testid="dashboard-stats">
            <button type="button" class="stat cursor-pointer border-0 bg-transparent text-left transition hover:bg-base-200 focus-visible:outline-2 focus-visible:outline-offset-2" data-testid="stat-scripts" aria-label="Open Scripts List" @click="onNavigate?.('scripts-list')">
              <div class="stat-figure text-primary">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="inline-block h-8 w-8 stroke-current">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <div class="stat-title">Total Scripts</div>
              <div class="stat-value text-primary">{{ stats.totalScripts }}</div>
              <div class="stat-desc">{{ stats.usedScripts }} used · {{ stats.unusedScripts }} unused</div>
              <div v-if="stats.pythonSummary" class="stat-desc text-xs opacity-60">{{ stats.pythonSummary }}</div>
            </button>

            <button type="button" class="stat cursor-pointer border-0 bg-transparent text-left transition hover:bg-base-200 focus-visible:outline-2 focus-visible:outline-offset-2" data-testid="stat-tasks" aria-label="Open Task" @click="onNavigate?.('task')">
              <div class="stat-figure text-secondary">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="inline-block h-8 w-8 stroke-current">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                </svg>
              </div>
              <div class="stat-title">Total Tasks</div>
              <div class="stat-value text-secondary">{{ stats.totalTasks }}</div>
              <div class="stat-desc">{{ stats.enabledTasks }} enabled · {{ stats.totalTasks - stats.enabledTasks }} disabled</div>
              <div v-if="stats.scheduleSummary" class="stat-desc text-xs opacity-60">{{ stats.scheduleSummary }}</div>
            </button>

            <button type="button" class="stat cursor-pointer border-0 bg-transparent text-left transition hover:bg-base-200 focus-visible:outline-2 focus-visible:outline-offset-2" data-testid="stat-runs" aria-label="Open Logging" @click="onNavigate?.('logging')">
              <div class="stat-figure text-secondary">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="inline-block h-8 w-8 stroke-current">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div class="stat-value">{{ stats.totalRuns > 0 ? `${stats.successRate}%` : '—' }}</div>
              <div class="stat-title">Success rate</div>
              <div class="stat-desc">{{ stats.successRuns }} of {{ stats.totalRuns }} runs succeeded</div>
              <div v-if="stats.lastRunName" class="stat-desc text-xs opacity-60">Last: {{ stats.lastRunName }} ({{ stats.lastRunStatus }})</div>
            </button>
          </div>

          <div class="stats shadow w-full mt-4" data-testid="dashboard-stats-secondary">
            <button type="button" class="stat cursor-pointer border-0 bg-transparent text-left transition hover:bg-base-200 focus-visible:outline-2 focus-visible:outline-offset-2" data-testid="stat-next-run" aria-label="Open Task" @click="onNavigate?.('task')">
              <div class="stat-figure text-secondary">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="inline-block h-8 w-8 stroke-current">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div class="stat-title">Next Run</div>
              <div class="stat-value text-sm font-medium">{{ stats.nextRunName ?? '—' }}</div>
              <div v-if="stats.nextRunAt" class="stat-desc">{{ formatRunDate(stats.nextRunAt) }}</div>
              <div v-else class="stat-desc">No upcoming runs</div>
            </button>

            <button type="button" class="stat cursor-pointer border-0 bg-transparent text-left transition hover:bg-base-200 focus-visible:outline-2 focus-visible:outline-offset-2" data-testid="stat-runs-today" aria-label="Open Logging" @click="onNavigate?.('logging')">
              <div class="stat-figure text-secondary">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="inline-block h-8 w-8 stroke-current">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </div>
              <div class="stat-title">Runs Today</div>
              <div class="stat-value">{{ stats.runsToday }}</div>
              <div class="stat-desc">executions since midnight</div>
            </button>
          </div>
          <div class="divider"></div>
          <section class="card border border-base-300 bg-base-100 shadow-sm" data-testid="system-info">
            <div class="card-body">
              <div class="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h2 class="card-title">System Info</h2>
                  <p class="text-sm opacity-70">Host configuration compared with the app lock version.</p>
                </div>
                <span v-if="systemInfo?.status === 'matched'" class="badge badge-success">Matched</span>
                <span v-else-if="systemInfo?.status === 'mismatch'" class="badge badge-warning">Mismatch</span>
                <span v-else-if="systemInfo" class="badge badge-error">Unavailable</span>
                <span v-else class="loading loading-spinner loading-sm" aria-label="Checking system info"></span>
              </div>
              <div class="grid gap-3 sm:grid-cols-2">
                <div>
                  <div class="text-xs uppercase opacity-60">Host status</div>
                  <div class="font-medium">{{ systemInfo?.hostVersion ?? 'Unable to read host version' }}</div>
                </div>
                <div>
                  <div class="text-xs uppercase opacity-60">App lock version</div>
                  <div class="font-medium">{{ systemInfo?.appVersion ?? 'Checking...' }}</div>
                </div>
              </div>
              <div v-if="systemInfo && systemInfo.status !== 'matched'" class="card-actions justify-end">
                <button type="button" class="btn btn-primary btn-sm" data-testid="resolve-system-info" @click="onNavigate?.('setting')">Resolve now</button>
              </div>
              <div class="divider my-2"></div>
              <div data-testid="runtime-requirement">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div class="text-xs uppercase opacity-60">Python runtime</div>
                    <div class="font-medium">{{ runtimeResult?.message ?? 'Checking...' }}</div>
                    <div v-if="runtimeResult?.detail" class="text-xs opacity-60">{{ runtimeResult.detail }}</div>
                    <div v-if="runtimeResult?.status === 'met' && runtimeResult.resolvedPath" class="text-xs opacity-60">{{ runtimeResult.resolvedPath }}</div>
                  </div>
                  <span v-if="runtimeResult" class="badge" :class="runtimeStatusBadge(runtimeResult.status)" data-testid="runtime-status">{{ runtimeStatusLabel(runtimeResult.status) }}</span>
                  <span v-else class="loading loading-spinner loading-sm" aria-label="Checking runtime"></span>
                </div>
                <div v-if="runtimeResult && runtimeResult.status !== 'met'" class="card-actions justify-end">
                  <button type="button" class="btn btn-primary btn-sm" data-testid="resolve-runtime"
                          :disabled="runtimeResolving" @click="resolveRuntime">
                    <span v-if="runtimeResolving" class="loading loading-spinner loading-xs"></span>
                    {{ runtimeResult.status === 'deferred' ? 'Try again' : 'Resolve' }}
                  </button>
                </div>
              </div>
            </div>
          </section>
          <div class="divider"></div>
          <section class="mt-6" data-testid="recent-executions">
            <h2 class="mb-3 text-lg font-semibold">Recent Executions</h2>
            <div v-if="recentRuns.length === 0" class="alert alert-info" data-testid="recent-executions-empty" role="alert">
              <span>No executions yet.</span>
            </div>
            <table v-else class="table table-zebra w-full" data-testid="recent-executions-table">
              <thead>
                <tr><th>Task</th><th>Status</th><th>Started</th><th>Finished</th><th>Exit Code</th></tr>
              </thead>
              <tbody>
                <tr v-for="run in recentRuns" :key="run.id" :data-testid="`recent-execution-row-${run.id}`">
                  <td>{{ taskName(run.taskId) }}</td>
                  <td><span class="badge" :class="run.status === 'success' ? 'badge-success' : run.status === 'failed' ? 'badge-error' : 'badge-warning'">{{ run.status }}</span></td>
                  <td>{{ formatRunDate(run.startedAt) }}</td>
                  <td>{{ formatRunDate(run.finishedAt) }}</td>
                  <td>{{ run.exitCode ?? '-' }}</td>
                </tr>
              </tbody>
            </table>
          </section>
          <p v-if="loaded && stats.totalScripts === 0 && stats.totalTasks === 0" class="text-gray-500 mt-4">
            No scripts or tasks yet. Add a script from the Scripts List page to get started.
          </p>
        </div>
      </slot>
    </main>
    <footer class="region card footer p-4 m-2 rounded border border-gray-300 bg-gray-100 mt-4 text-center text-sm text-gray-500 dark:bg-[#2f2f2f] dark:border-[#404040] dark:text-[#999999]">
      <slot name="footer">
        <div class="card-body">
          <p>&copy; 2026 Scripts Management</p>
        </div>
      </slot>
    </footer>
  </div>
</template>
