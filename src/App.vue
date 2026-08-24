<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useNavigation } from './composables/useNavigation';
import { createAppContext, provideAppContext } from './composables/useAppContext';
import HomeView from './views/HomeView.vue';
import ScriptsListView from './views/ScriptsListView.vue';
import TaskView from './views/TaskView.vue';
import LoggingView from './views/LoggingView.vue';
import SettingView from './views/SettingView.vue';
import HomeIcon from './components/icons/HomeIcon.vue';
import ScriptsListIcon from './components/icons/ScriptsListIcon.vue';
import TaskIcon from './components/icons/TaskIcon.vue';
import LoggingIcon from './components/icons/LoggingIcon.vue';
import SettingIcon from './components/icons/SettingIcon.vue';
import type { Component } from 'vue';
import { AppLogger } from './services/log/AppLogger';
import type { LogRepository } from './services/log/LogRepository';
import type { ScriptRepository } from './services/script/ScriptRepository';
import type { TaskRepository } from './services/task/TaskRepository';
import type { TaskRunRepository } from './services/task/TaskRunRepository';

interface Props {
  scriptRepository?: ScriptRepository;
  taskRepository?: TaskRepository;
  logRepository?: LogRepository;
  logger?: AppLogger;
  taskRunRepository?: TaskRunRepository;
}

const props = defineProps<Props>();
const appContext = createAppContext(props);
provideAppContext(appContext);

const { navItems, activeView, setView } = useNavigation();

const views = computed(() => {
  switch (activeView.value) {
    case 'home':
      return HomeView;
    case 'scripts-list':
      return ScriptsListView;
    case 'task':
      return TaskView;
    case 'logging':
      return LoggingView;
    case 'setting':
      return SettingView;
    default:
      return HomeView;
  }
});

const viewIcons: Record<string, Component> = {
  home: HomeIcon,
  'scripts-list': ScriptsListIcon,
  task: TaskIcon,
  logging: LoggingIcon,
  setting: SettingIcon,
};

onMounted(async () => {
  appContext.logger.record('app', 'startup');
  // Run the Python runtime check ONCE at startup. The result is cached in the
  // reactive runtimeCheckResult ref so views read it without re-probing.
  try {
    const result = await appContext.runtimeRequirement.check();
    appContext.runtimeCheckResult.value = result;
    if (result.status === 'met' && result.resolvedPath) {
      await appContext.logger.record('runtime.check', `Python resolved at startup: ${result.resolvedPath} [${result.message}]`, 'info');
    } else {
      await appContext.logger.record('runtime.check', `${result.message}`, 'info');
    }
  } catch (error) {
    appContext.runtimeCheckResult.value = {
      status: 'failed',
      requirementName: 'Python runtime',
      message: 'Startup runtime check failed.',
      detail: error instanceof Error ? error.message : String(error),
      resolvedPath: null,
    };
    await appContext.logger.record('runtime.check', 'Startup runtime check threw an unexpected error.', 'error');
  }
});
</script>

<template>
  <div class="app-container flex h-screen w-full">
    <nav class="sidebar w-52 border-r border-gray-300 bg-gray-100 flex-shrink-0 sticky top-0 self-start h-screen dark:bg-[#2f2f2f] dark:border-[#404040]">
      <ul class="menu menu-vertical space-y-1">
        <li
          v-for="item in navItems"
          :key="item.id"
          class="nav-item"
          :aria-current="activeView === item.id ? 'page' : undefined"
        >
          <button
            class="nav-button btn btn-ghost justify-start flex w-full items-center gap-2.5 px-4 py-3 text-left rounded hover:bg-gray-300 transition-all duration-200 dark:text-[#f6f6f6] dark:hover:bg-[#404040] [&.active]:bg-blue-600 [&.active]:text-white dark:[&.active]:bg-blue-600 dark:[&.active]:text-white"
            :class="{ active: activeView === item.id }"
            @click="setView(item.id)"
          >
            <component :is="viewIcons[item.id]" />
            {{ item.label }}
          </button>
        </li>
      </ul>
    </nav>
    <main class="main-content flex-1 p-4 overflow-y-auto">
      <component :is="views" :on-navigate="setView" />
    </main>
  </div>
</template>


