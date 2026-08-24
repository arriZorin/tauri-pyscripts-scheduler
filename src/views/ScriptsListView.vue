<template>
  <div class="view-container w-full">
    <header class="region header card p-4 m-2 rounded border border-gray-300 bg-gray-100 mb-4 dark:bg-[#2f2f2f] dark:border-[#404040] flex items-center justify-between">
      <div class="card-body">
        <h1 class="text-xl font-semibold">Scripts List</h1>
        <p class="text-gray-600">Manage your Python scripts</p>
      </div>
      <button @click="handleRefresh" class="btn btn-ghost px-3 py-2 rounded bg-gray-600 text-white hover:bg-gray-500" data-testid="refresh-btn">Refresh</button>
    </header>
    <main class="region body card p-4 m-2 rounded border border-gray-300 bg-white min-h-[200px] dark:bg-[#333333] dark:border-[#404040]">
      <div class="flex gap-2 mb-4">
        <button @click="handleAddFile" class="btn btn-primary px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-500 btn-script-action" data-testid="add-file-btn">Add File</button>
        <button @click="handleAddFolder" class="btn btn-primary px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-500 btn-script-action" data-testid="add-folder-btn">Add Folder</button>
      </div>
      <div class="card-body">
        <div v-if="busy" class="alert alert-info text-gray-600" role="alert"><AlertIcon kind="info" /><span>Adding...</span></div>
        <div v-if="error" role="alert" class="alert alert-error text-red-600"><AlertIcon kind="error" /><span>{{ error }}</span></div>
        <div v-if="repairError" data-testid="repair-error" role="alert" class="alert alert-error text-red-600"><AlertIcon kind="error" /><span>{{ repairError }}</span></div>
        <div v-if="summary" class="alert alert-info text-gray-600" role="alert"><AlertIcon kind="info" /><span>{{ summary }}</span></div>
      </div>
      <table data-testid="script-table" class="table table-zebra w-full text-sm">
        <thead>
          <tr>
            <th>Name</th>
            <th>Path</th>
            <th>Status</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in sortedScripts" :key="s.id">
            <td>{{ s.name }}</td>
            <td>
              {{ s.path }}
              <span v-if="missingScriptIds.includes(s.id)" class="badge badge-warning ml-2" :data-testid="`missing-script-${s.id}`">Missing</span>
            </td>
            <td>
              <span class="badge" :class="usedScriptIds.has(s.id) ? 'badge-success' : 'badge-ghost'" :data-testid="`script-status-${s.id}`">{{ usedScriptIds.has(s.id) ? 'Used' : 'Unused' }}</span>
            </td>
            <td :title="s.createdAt"><RelativeTime :date="s.createdAt" /></td>
            <td>
              <div class="join">
                <button v-if="!missingScriptIds.includes(s.id)" @click="openEditDialog(s)" :data-testid="`edit-script-${s.id}`" class="btn btn-xs join-item" :title="`Edit ${s.name}`">Edit</button>
                <button v-if="missingScriptIds.includes(s.id)" @click="handleRepair(s)" :data-testid="`repair-script-${s.id}`" class="btn btn-xs btn-warning join-item" :title="`Repair ${s.name}`">Repair</button>
                <button @click="handleDelete(s)" :data-testid="`delete-script-${s.id}`" class="btn btn-xs btn-error join-item" :title="`Delete ${s.name}`">Delete</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>


      <!-- Edit Dialog -->
      <dialog id="edit-dialog" v-if="isEditing" data-testid="edit-dialog" class="modal modal-open" role="dialog">
        <div class="modal-box p-4 max-w-md">
          <h3 class="text-lg font-bold mb-4">Edit Script</h3>
          <div class="form-control w-full mb-4">
            <label class="label">
              <span class="label-text">Name</span>
              <input v-model="editName" type="text" data-testid="edit-name-input" class="input input-bordered w-full" placeholder="Script name" />
            </label>
          </div>
          <div class="form-control w-full mb-4">
            <label class="label">
              <span class="label-text">Description</span>
              <textarea v-model="editDescription" data-testid="edit-description-input" class="textarea textarea-bordered h-20" placeholder="Script description" />
            </label>
          </div>
          <div class="form-control w-full mb-4">
            <label class="label">
              <span class="label-text">Python Version</span>
              <select v-model="editPythonVersion" data-testid="edit-python-version" class="select select-bordered w-full">
                <option value="3.11">3.11 (default)</option>
                <option value="3.12">3.12</option>
                <option value="3.13">3.13</option>
              </select>
            </label>
          </div>
          <div v-if="editError" class="alert alert-error mb-4" role="alert"><AlertIcon kind="error" /><span>{{ editError }}</span></div>
          <div class="flex justify-between items-center">
            <div class="text-sm text-gray-600">
              <div class="mb-1">Path: <span class="script-name">{{ selectedScript?.path }}</span></div>
              <div>Type: <span class="script-name">{{ selectedScript?.type }}</span></div>
            </div>
            <div class="flex gap-2">
              <button @click="saveEdit" data-testid="save-edit-btn" class="btn btn-primary btn-sm">Save</button>
              <button @click="closeEditDialog" data-testid="cancel-edit-btn" class="btn btn-ghost btn-sm">Cancel</button>
            </div>
          </div>
        </div>
        <form method="dialog" class="modal-backdrop">
          <button @click.prevent="closeEditDialog">close</button>
        </form>
      </dialog>

      <!-- Delete Confirmation Modal -->
      <dialog id="delete-dialog" v-if="deleteTarget" data-testid="delete-dialog" class="modal modal-open" role="dialog">
        <div class="modal-box p-4 max-w-md">
          <h3 class="text-lg font-bold mb-2">Delete Script</h3>
          <p class="text-gray-600 mb-4">Are you sure you want to delete <strong>{{ deleteTarget.name }}</strong>?</p>
          <div v-if="linkedTasks.length > 0" class="alert alert-warning mb-4" data-testid="linked-tasks-warning" role="alert">
            <AlertIcon kind="warning" />
            <div>
              <strong>{{ linkedTasks.length }} linked task(s) will also be deleted:</strong>
              <ul class="list-disc list-inside mt-1">
                <li v-for="task in linkedTasks" :key="task.id">{{ task.name }}</li>
              </ul>
            </div>
          </div>
          <div v-if="deleteError" class="alert alert-error mb-4" data-testid="delete-error" role="alert"><AlertIcon kind="error" /><span>{{ deleteError }}</span></div>
          <div class="flex justify-between items-center">
            <div class="text-sm text-gray-500">
              <div class="mb-1">Path: <span class="script-name">{{ deleteTarget.path }}</span></div>
              <div>Type: <span class="script-name">{{ deleteTarget.type }}</span></div>
            </div>
            <div class="flex gap-2">
              <button @click="confirmDelete" data-testid="confirm-delete-btn" class="btn btn-error btn-sm">{{ linkedTasks.length > 0 ? 'Delete script & tasks' : 'Delete' }}</button>
              <button @click="cancelDelete" data-testid="cancel-delete-btn" class="btn btn-ghost btn-sm">Cancel</button>
            </div>
          </div>
        </div>
        <form method="dialog" class="modal-backdrop">
          <button @click.prevent="cancelDelete">close</button>
        </form>
      </dialog>

      <!-- Deps scan modal -->
      <dialog id="deps-dialog" v-if="pendingDeps" data-testid="deps-dialog" class="modal modal-open" role="dialog">
        <div class="modal-box p-4 max-w-md">
          <h3 class="text-lg font-bold mb-2">Dependencies Detected</h3>
          <p class="text-sm text-gray-600 mb-4">
            No <code>requirements.txt</code> found in this folder. The following
            third-party packages were detected:
          </p>
          <div class="mb-4 space-y-1">
            <div v-for="dep in pendingDeps.detected" :key="dep" class="flex items-center gap-2 p-2 bg-gray-50 rounded dark:bg-[#3a3a3a]">
              <code class="text-sm">{{ dep }}</code>
            </div>
          </div>
          <p class="text-sm text-gray-500 mb-4">
            Create a <code>requirements.txt</code> file? Dependencies will be
            installed in the folder's virtual environment.
          </p>
          <div class="flex gap-2 justify-end">
            <button @click="confirmDeps" data-testid="confirm-deps-btn" class="btn btn-primary btn-sm">Create</button>
            <button @click="skipDeps" data-testid="skip-deps-btn" class="btn btn-ghost btn-sm">Skip</button>
          </div>
        </div>
        <form method="dialog" class="modal-backdrop">
          <button @click.prevent="skipDeps">close</button>
        </form>
      </dialog>
      <div class="card-body">
        <div v-if="scripts.length === 0" class="alert alert-info text-gray-600" role="alert"><AlertIcon kind="info" /><span>No scripts yet. Add a .py file or folder.</span></div>
      </div>
    </main>
    <footer class="region footer card p-4 m-2 rounded border border-gray-300 bg-gray-100 mt-4 text-center text-sm text-gray-500 dark:bg-[#2f2f2f] dark:border-[#404040] dark:text-[#999999]">
      <div class="card-body">
        <p>&copy; 2026 Scripts Management</p>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, defineComponent, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import AlertIcon from '../components/icons/AlertIcon.vue';
import { useAppContext } from '../composables/useAppContext';
import { useAutoDismiss } from '../composables/useAutoDismiss';
import { useScripts } from '../services/script/import/useScripts';
import { sortScripts } from '../services/script/scriptLabels';
import { findMissingScriptIds } from '../services/script/scriptReconciliation';
import { onMounted } from 'vue';
import type { Script } from '../models/Script';
import type { Task } from '../models/Task';
import { useTimeAgo } from '@vueuse/core';

const RelativeTime = defineComponent({
  props: {
    date: { type: String, required: true },
  },
  setup(props) {
    const timeAgo = useTimeAgo(props.date);
    return () => timeAgo.value;
  },
});

const { scriptRepository: repository, picker, scanner, taskRepository, taskScheduler, scriptPathChecker, venvSync } = useAppContext();

const { scripts, error, busy, addScriptFile, addScriptFolder, load } = useScripts({ repository, picker, scanner });
const sortedScripts = computed(() => sortScripts(scripts.value));
const missingScriptIds = ref<string[]>([]);

const usedScriptIds = ref<Set<string>>(new Set());

async function loadAndReconcile() {
  await load();
  missingScriptIds.value = await findMissingScriptIds(scripts.value, scriptPathChecker.exists);
  // Load tasks to determine used/unused status per script
  try {
    const tasks = await taskRepository.list();
    usedScriptIds.value = new Set(tasks.map(t => t.scriptId));
  } catch {
    usedScriptIds.value = new Set();
  }
}

const operationSummary = ref('');
const repairError = ref('');
useAutoDismiss(error);
useAutoDismiss(operationSummary);
useAutoDismiss(repairError);
const summary = computed(() => operationSummary.value);

// Edit state and refs
const selectedScript = ref<Script | null>(null);
const editName = ref('');
const editDescription = ref('');
const editPythonVersion = ref('3.11');
const isEditing = ref(false);
const editError = ref<string | null>(null);

// Delete state
const deleteTarget = ref<Script | null>(null);
const linkedTasks = ref<Task[]>([]);
const deleteError = ref('');

// Deps scan state
const pendingDeps = ref<{ folder: string; script: Script; detected: string[] } | null>(null);

// Edit dialog handlers
function openEditDialog(script: Script) {
  selectedScript.value = script;
  editName.value = script.name;
  editDescription.value = script.description ?? '';
  editPythonVersion.value = script.pythonVersion ?? '3.11';
  editError.value = null;
  operationSummary.value = '';
  isEditing.value = true;
}

function closeEditDialog() {
  isEditing.value = false;
  selectedScript.value = null;
  editError.value = null;
}

async function saveEdit() {
  if (!selectedScript.value) return;

  editError.value = null;

  // Trim name and reject empty
  const trimmedName = editName.value.trim();
  if (!trimmedName) {
    editError.value = 'Script name cannot be empty.';
    return;
  }

  try {
    await repository.update(selectedScript.value.id, {
      name: trimmedName,
      description: editDescription.value.trim(),
      pythonVersion: editPythonVersion.value,
    });
    // Sync venv for the folder (pythonVersion or requirements.txt may have changed)
    await venvSync.syncFolder(selectedScript.value.path, editPythonVersion.value);
    await loadAndReconcile();
    closeEditDialog();
    operationSummary.value = `Updated ${trimmedName}.`;
  } catch (e) {
    editError.value = typeof e === 'string' && e.trim() ? e : e instanceof Error ? e.message : 'Failed to update script.';
  }
}

async function handleDelete(script: Script) {
  if (!script) return;

  deleteError.value = '';
  // Collect tasks that reference this script so the dialog can warn and
  // cascade deletion of the linked Windows tasks.
  try {
    const tasks = await taskRepository.list();
    linkedTasks.value = tasks.filter(task => task.scriptId === script.id);
  } catch {
    linkedTasks.value = [];
  }
  deleteTarget.value = script;
}

function cancelDelete() {
  deleteTarget.value = null;
  linkedTasks.value = [];
  deleteError.value = '';
}

async function confirmDelete() {
  const target = deleteTarget.value;
  if (!target) return;

  try {
    // Cascade: remove linked tasks (JSON + Windows registration) first so no
    // orphaned Windows task keeps running a deleted script, then the script.
    for (const task of linkedTasks.value) {
      await taskRepository.delete(task.id);
      await taskScheduler.delete(task.id);
    }
    const deletePath = target.path;
    await repository.delete(target.id);
    // Cleanup venv — if no more scripts in this folder, venv is removed
    await venvSync.cleanupFolder(deletePath);
    await loadAndReconcile();

    operationSummary.value = linkedTasks.value.length > 0
      ? `Deleted ${target.name} and ${linkedTasks.value.length} linked task(s).`
      : `Deleted ${target.name}.`;
    deleteTarget.value = null;
    linkedTasks.value = [];
    deleteError.value = '';
  } catch (e) {
    // Keep the dialog open so the error is visible; nothing was committed.
    deleteError.value = typeof e === 'string' && e.trim() ? e : e instanceof Error ? e.message : 'Failed to delete script.';
  }
}

function scriptDir(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index === -1 ? path : normalized.slice(0, index);
}

async function confirmDeps() {
  if (!pendingDeps.value) return;
  const { folder, script, detected } = pendingDeps.value;
  pendingDeps.value = null;
  try {
    // Check for pyproject.toml — if present, use uv sync (project mode)
    const hasPyproject = await invoke<boolean>('path_exists', { path: folder + '/pyproject.toml' });
    if (hasPyproject) {
      await invoke('ensure_script_venv', { dirPath: folder, pythonVersion: script.pythonVersion ?? '3.11' });
      await invoke('uv_sync_project', { dirPath: folder, pythonVersion: script.pythonVersion ?? '3.11' });
      operationSummary.value = `Synced uv project in ${folder} with ${detected.length} dep(s).`;
    } else {
      await invoke('write_requirements_txt', { dirPath: folder, deps: detected });
      // Ensure the venv exists in the script folder for this folder's pythonVersion
      await invoke('ensure_script_venv', { dirPath: folder, pythonVersion: script.pythonVersion ?? '3.11' });
      // Sync the deps from requirements.txt into the venv
      await invoke('sync_script_deps', { dirPath: folder, requirements: detected });
      operationSummary.value = `Created requirements.txt with ${detected.length} dep(s).`;
    }
  } catch (e) {
    error.value = typeof e === 'string' && e.trim() ? e : e instanceof Error ? e.message : 'Failed to process dependencies.';
  }
}

function skipDeps() {
  if (!pendingDeps.value) return;
  const { script } = pendingDeps.value;
  pendingDeps.value = null;
  // Still sync venv (with empty deps) so the venv is ready for future use
  venvSync.syncFolder(script.path, script.pythonVersion ?? '3.11').catch(() => {});
  operationSummary.value = 'Skipped dependency scan.';
}

async function handleAddFile() {
  const result = await addScriptFile();
  if (result.added > 0) {
    // Auto-scan for deps on newly added scripts
    for (const s of scripts.value) {
      try {
        const folder = scriptDir(s.path);
        // If pyproject.toml exists, this is a uv project — skip deps scan, just sync
        const hasPyproject = await invoke<boolean>('path_exists', { path: folder + '/pyproject.toml' });
        if (hasPyproject) {
          await venvSync.syncFolder(s.path, s.pythonVersion ?? '3.11');
          continue;
        }
        const existing = await invoke<string[]>('read_folder_requirements', { dirPath: folder });
        if (existing.length === 0) {
          const detected = await invoke<string[]>('scan_script_deps', { filePath: s.path });
          if (detected.length > 0) {
            pendingDeps.value = { folder, script: s, detected };
            return; // Show modal first — venv sync happens after confirm
          }
        }
        await venvSync.syncFolder(s.path, s.pythonVersion ?? '3.11');
      } catch { /* skip errors on add */ }
    }
  }
  operationSummary.value = `Added ${result.added} script(s), skipped ${result.skipped}.`;
}

async function handleAddFolder() {
  const result = await addScriptFolder();
  if (result.added > 0) {
    for (const s of scripts.value) {
      try {
        const folder = scriptDir(s.path);
        // If pyproject.toml exists, this is a uv project — skip deps scan
        const hasPyproject = await invoke<boolean>('path_exists', { path: folder + '/pyproject.toml' });
        if (hasPyproject) {
          await venvSync.syncFolder(s.path, s.pythonVersion ?? '3.11');
          continue;
        }
        const existing = await invoke<string[]>('read_folder_requirements', { dirPath: folder });
        if (existing.length === 0) {
          const detected = await invoke<string[]>('scan_script_deps', { filePath: s.path });
          if (detected.length > 0) {
            pendingDeps.value = { folder, script: s, detected };
            return;
          }
        }
        await venvSync.syncFolder(s.path, s.pythonVersion ?? '3.11');
      } catch { /* skip */ }
    }
  }
  operationSummary.value = `Added ${result.added} script(s), skipped ${result.skipped}.`;
}

async function handleRefresh() {
  await loadAndReconcile();
}

function fileName(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path;
}

async function handleRepair(script: Script) {
  repairError.value = '';
  const selectedPath = await picker.pickFile();
  if (!selectedPath) return;

  if (fileName(selectedPath).toLowerCase() !== fileName(script.name).toLowerCase()) {
    repairError.value = 'Script did not match';
    return;
  }

  try {
    const updatedScript = await repository.update(script.id, { path: selectedPath });
    // Sync venv for the new path's folder (requirements.txt might differ)
    await venvSync.syncFolder(selectedPath, updatedScript.pythonVersion ?? '3.11');
    const linkedTasks = (await taskRepository.list()).filter((task) => task.scriptId === script.id);
    for (const task of linkedTasks) {
      await taskScheduler.update(task, updatedScript);
    }
    await loadAndReconcile();
    operationSummary.value = `Repaired ${script.name}.`;
  } catch (e) {
    repairError.value = typeof e === 'string' && e.trim() ? e : e instanceof Error ? e.message : 'Failed to repair script.';
  }
}

onMounted(async () => {
  await loadAndReconcile();
});
</script>
