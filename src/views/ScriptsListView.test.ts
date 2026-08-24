import { describe, it, expect } from 'vitest'
import { createApp, nextTick } from 'vue'
import ScriptsListView from './ScriptsListView.vue'
import { appContextKey, createAppContext } from '../composables/useAppContext'

// Fake implementations for testing (no Tauri runtime needed)
class FakeScriptRepository {
  public items: any[] = []

  constructor(initial: any[] = []) {
    this.items = initial
  }

  list(): any[] {
    return [...this.items]
  }

  create(input: any): Promise<any> {
    const s = {
      ...input,
      id: crypto.randomUUID(),
      createdAt: '2024-01-01T00:00:00.000Z', // Fixed date for testing
      updatedAt: '2024-01-01T00:00:00.000Z',
    }
    this.items.push(s)
    return Promise.resolve(s)
  }

  get(id: string): Promise<any> {
    return Promise.resolve(this.items.find((s) => s.id === id) ?? null)
  }

  update(id: string, input: any): Promise<any> {
    const index = this.items.findIndex((s) => s.id === id)
    if (index === -1) {
      return Promise.reject(new Error('Script not found'))
    }
    this.items[index] = { ...this.items[index], ...input, updatedAt: new Date().toISOString() }
    return Promise.resolve(this.items[index])
  }

  delete(id: string): Promise<void> {
    this.items = this.items.filter((s) => s.id !== id)
    return Promise.resolve()
  }
}

class FakeScriptPicker {
  public fileResult: string | null = null
  public folderResult: string | null = null

  pickFile(): Promise<string | null> {
    return Promise.resolve(this.fileResult)
  }

  pickFolder(): Promise<string | null> {
    return Promise.resolve(this.folderResult)
  }
}

class FakeFileScanner {
  public result: string[] = []

  scan(): Promise<string[]> {
    return Promise.resolve(this.result)
  }
}

class FakeTaskRepository {
  public items: any[] = []

  list(): Promise<any[]> {
    return Promise.resolve([...this.items])
  }

  delete(id: string): Promise<void> {
    this.items = this.items.filter((t) => t.id !== id)
    return Promise.resolve()
  }
}

class FakeTaskScheduler {
  public updates: Array<{ taskId: string; scriptPath: string }> = []
  public deletes: string[] = []
  public error: unknown = null

  update(task: any, script: any): Promise<void> {
    if (this.error) return Promise.reject(this.error)
    this.updates.push({ taskId: task.id, scriptPath: script.path })
    return Promise.resolve()
  }

  delete(id: string): Promise<void> {
    if (this.error) return Promise.reject(this.error)
    this.deletes.push(id)
    return Promise.resolve()
  }
}

class FakeVenvSync {
  async syncFolder(_path: string, _version: string) { return Promise.resolve() }
  async cleanupFolder(_path: string) { return Promise.resolve() }
}

function mountView(repo: FakeScriptRepository, picker: FakeScriptPicker, scanner: FakeFileScanner, taskRepository = new FakeTaskRepository(), taskScheduler = new FakeTaskScheduler(), scriptPathChecker: { exists: (path: string) => Promise<boolean> } = { exists: async () => true }) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(ScriptsListView)
  app.provide(appContextKey, createAppContext({
    scriptRepository: repo as never,
    picker: picker as never,
    scanner: scanner as never,
    taskRepository: taskRepository as never,
    taskScheduler: taskScheduler as never,
    scriptPathChecker,
    venvSync: new FakeVenvSync() as never,
  }))
  app.mount(container)
  return { container, app, taskRepository, taskScheduler }
}

function buttonTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('button')).map((b) => b.textContent?.trim() ?? '')
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0))
  await nextTick()
}

describe('ScriptsListView', () => {
  it('renders header, footer, and Add File/Add Folder buttons', async () => {
    const { container, app } = mountView(new FakeScriptRepository(), new FakeScriptPicker(), new FakeFileScanner())
    await nextTick()

    expect(container.querySelector('.region.header h1')?.textContent?.trim()).toBe('Scripts List')
    expect(container.querySelector('.region.header p')?.textContent?.trim()).toBe('Manage your Python scripts')
    expect(container.querySelector('.region.footer')?.textContent?.trim()).toBe('© 2026 Scripts Management')
    expect(buttonTexts(container).sort()).toEqual(['Add File', 'Add Folder', 'Refresh'])

    app.unmount()
  })

  it('renders empty state when repo has no scripts', async () => {
    const { container, app } = mountView(new FakeScriptRepository(), new FakeScriptPicker(), new FakeFileScanner())
    await nextTick()

    expect(container.querySelector('.region.body')?.textContent).toContain('No scripts yet. Add a .py file or folder.')

    app.unmount()
  })

  it('shows a seeded script after a refresh action (add file with duplicate path)', async () => {
    const repo = new FakeScriptRepository([
      {
        name: 'backup.py',
        path: 'C:/scripts/backup.py',
        id: 'test-1',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ])
    const picker = new FakeScriptPicker()
    // Picking the already-seeded path is a duplicate → nothing created, but the list refreshes (load())
    picker.fileResult = 'C:/scripts/backup.py'
    const { container, app } = mountView(repo, picker, new FakeFileScanner())
    await nextTick()

    const addBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Add File')!
    addBtn.click()
    await flush()

    const rows = Array.from(container.querySelectorAll('tbody tr'))
    const listItems = rows.map((row) => row.textContent)
    expect(listItems[0]).toContain('backup.pyC:/scripts/backup.py')
    expect(listItems[0]).toContain('Edit')
    expect(listItems[0]).toContain('Delete')
    expect(container.querySelector('.region.body')?.textContent).toContain('Added 0 script(s), skipped 1.')

    app.unmount()
  })

  it('clicking Add File adds the picked script', async () => {
    const repo = new FakeScriptRepository()
    const picker = new FakeScriptPicker()
    picker.fileResult = 'C:/scripts/new.py'
    const { container, app } = mountView(repo, picker, new FakeFileScanner())
    await nextTick()

    const addBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Add File')!
    addBtn.click()
    await flush()

    const rows = Array.from(container.querySelectorAll('tbody tr'))
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.textContent).toContain('new.py')
    expect(row.textContent).toContain('C:/scripts/new.py')

    app.unmount()
  })

  it('clicking Add Folder adds all .py files, ignoring others', async () => {
    const repo = new FakeScriptRepository()
    const picker = new FakeScriptPicker()
    picker.folderResult = 'C:/a'
    const scanner = new FakeFileScanner()
    scanner.result = ['C:/a/x.py', 'C:/a/y.py', 'C:/a/readme.txt']
    const { container, app } = mountView(repo, picker, scanner)
    await nextTick()

    const addBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Add Folder')!
    addBtn.click()
    await flush()

    const rows = Array.from(container.querySelectorAll('tbody tr'))
    expect(rows).toHaveLength(2)
    // Check individual td cells in each row
    const firstRowCells = Array.from(rows[0].querySelectorAll('td')).map(td => td.textContent)
    const secondRowCells = Array.from(rows[1].querySelectorAll('td')).map(td => td.textContent)
    expect(firstRowCells).toContain('x.py')
    expect(firstRowCells[1]).toContain('C:/a/x.py')
    // First 3 cells should be: name, path, status - the 4th is created date which varies
    expect(firstRowCells[0]).toBe('x.py')
    expect(firstRowCells[1]).toContain('C:/a/x.py')
    expect(firstRowCells[2]).toBe('Unused')
    expect(firstRowCells[3]).toBeTruthy()
    expect(secondRowCells).toContain('y.py')
    expect(secondRowCells[1]).toContain('C:/a/y.py')
    expect(secondRowCells[0]).toBe('y.py')
    expect(secondRowCells[1]).toContain('C:/a/y.py')
    expect(secondRowCells[2]).toBe('Unused')
    expect(secondRowCells[3]).toBeTruthy()

    app.unmount()
  })

  it('sorts rows by name when the repository returns scripts in a different order', async () => {
    const repo = new FakeScriptRepository([
      {
        id: 'z-1',
        name: 'zebra.py',
        path: 'C:/scripts/zebra.py',
        type: 'python',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
      {
        id: 'a-1',
        name: 'alpha.py',
        path: 'C:/scripts/alpha.py',
        type: 'python',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ])
    const { container, app } = mountView(repo, new FakeScriptPicker(), new FakeFileScanner())
    await nextTick()
    await flush()

    const rows = Array.from(container.querySelectorAll('tbody tr'))
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('alpha.py')
    expect(rows[1].textContent).toContain('zebra.py')

    app.unmount()
  })

  it('renders saved scripts from the repository on mount without any interaction', async () => {
    const repo = new FakeScriptRepository([
      {
        id: 'test-1',
        name: 'backup.py',
        path: 'C:/scripts/backup.py',
        type: 'python',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ])
    const { container, app } = mountView(repo, new FakeScriptPicker(), new FakeFileScanner())
    await nextTick()
    await flush()

    const rows = Array.from(container.querySelectorAll('tbody tr'))
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.textContent).toContain('backup.py')
    expect(row.textContent).toContain('C:/scripts/backup.py')
    expect(row.textContent).toContain('Unused')
    expect(row.querySelector('td[title="2024-01-01T00:00:00.000Z"]')?.textContent).toBeTruthy()

    app.unmount()
  })

  it('Refresh button reloads the list when clicked', async () => {
    const repo = new FakeScriptRepository()
    const { container, app } = mountView(repo, new FakeScriptPicker(), new FakeFileScanner())
    await nextTick()
    await flush()

    // Empty repo → no rows after the initial auto-load
    expect(Array.from(container.querySelectorAll('tbody tr'))).toHaveLength(0)

    // External change: a script lands in the store after mount
    repo.items.push({
      id: 'test-2',
      name: 'late.py',
      path: 'C:/scripts/late.py',
      type: 'python',
      createdAt: '2024-01-02T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
    })

    const refreshBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Refresh'
    )!
    refreshBtn.click()
    await flush()

    const rows = Array.from(container.querySelectorAll('tbody tr'))
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('late.py')
    expect(rows[0].textContent).toContain('C:/scripts/late.py')

    app.unmount()
  })

  it('renders edit and delete actions and edits a script', async () => {
    const repo = new FakeScriptRepository([{
      id: 'edit-1', name: 'old.py', path: 'C:/old.py', type: 'python',
      description: 'old description', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
    }])
    const { container, app } = mountView(repo, new FakeScriptPicker(), new FakeFileScanner())
    await flush()

    expect(container.querySelector('[data-testid="edit-script-edit-1"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="delete-script-edit-1"]')).toBeTruthy()
    ;(container.querySelector('[data-testid="edit-script-edit-1"]') as HTMLElement).click()
    await nextTick()
    const editDialog = container.querySelector('[data-testid="edit-dialog"]')
    expect(editDialog).toBeTruthy()
    expect(editDialog?.classList.contains('modal')).toBe(true)
    expect(editDialog?.classList.contains('modal-open')).toBe(true)
    const nameInput = container.querySelector('[data-testid="edit-name-input"]') as HTMLInputElement
    nameInput.value = 'new.py'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    ;(container.querySelector('[data-testid="save-edit-btn"]') as HTMLElement).click()
    await flush()
    expect(repo.items[0].name).toBe('new.py')
    expect(container.querySelector('[data-testid="edit-dialog"]')).toBeNull()
    app.unmount()
  })

  it('deletes a script only after modal confirmation', async () => {
    const repo = new FakeScriptRepository([{
      id: 'delete-1', name: 'remove.py', path: 'C:/remove.py', type: 'python',
      createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
    }])
    const { container, app } = mountView(repo, new FakeScriptPicker(), new FakeFileScanner())
    await flush()
    ;(container.querySelector('[data-testid="delete-script-delete-1"]') as HTMLElement).click()
    await flush()
    expect(repo.items).toHaveLength(1)
    ;(container.querySelector('[data-testid="cancel-delete-btn"]') as HTMLElement).click()
    await nextTick()
    expect(repo.items).toHaveLength(1)
    ;(container.querySelector('[data-testid="delete-script-delete-1"]') as HTMLElement).click()
    await flush()
    ;(container.querySelector('[data-testid="confirm-delete-btn"]') as HTMLElement).click()
    await flush()
    expect(repo.items).toHaveLength(0)
    app.unmount()
  })

  it('opens a daisyUI confirmation dialog before deleting', async () => {
    const repo = new FakeScriptRepository([{
      id: 'dialog-1', name: 'confirm.py', path: 'C:/confirm.py', type: 'python',
      createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
    }])
    const { container, app } = mountView(repo, new FakeScriptPicker(), new FakeFileScanner())
    await flush()

    ;(container.querySelector('[data-testid="delete-script-dialog-1"]') as HTMLElement).click()
    await flush()

    const dialog = container.querySelector('[data-testid="delete-dialog"]')
    expect(dialog).toBeTruthy()
    expect(dialog?.classList.contains('modal')).toBe(true)
    expect(dialog?.textContent).toContain('confirm.py')
    expect(repo.items).toHaveLength(1)

    app.unmount()
  })

  it('warns about linked tasks in the delete dialog', async () => {
    const repo = new FakeScriptRepository([{
      id: 'linked-1', name: 'linked.py', path: 'C:/linked.py', type: 'python',
      createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
    }])
    const taskRepository = new FakeTaskRepository()
    taskRepository.items = [
      { id: 'task-a', name: 'Backup', scriptId: 'linked-1' },
      { id: 'task-b', name: 'Nightly', scriptId: 'linked-1' },
      { id: 'task-c', name: 'Other', scriptId: 'other-script' },
    ]
    const { container, app } = mountView(repo, new FakeScriptPicker(), new FakeFileScanner(), taskRepository)
    await flush()

    ;(container.querySelector('[data-testid="delete-script-linked-1"]') as HTMLElement).click()
    await flush()

    const dialog = container.querySelector('[data-testid="delete-dialog"]')
    expect(dialog?.textContent).toContain('2 linked task(s)')
    expect(dialog?.textContent).toContain('Backup')
    expect(dialog?.textContent).toContain('Nightly')
    expect(dialog?.textContent).not.toContain('Other')
    expect(repo.items).toHaveLength(1)
    expect(taskRepository.items).toHaveLength(3)

    app.unmount()
  })

  it('cascades deletion to linked tasks before deleting the script', async () => {
    const repo = new FakeScriptRepository([{
      id: 'linked-1', name: 'linked.py', path: 'C:/linked.py', type: 'python',
      createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
    }])
    const taskRepository = new FakeTaskRepository()
    taskRepository.items = [
      { id: 'task-a', name: 'Backup', scriptId: 'linked-1' },
      { id: 'task-b', name: 'Nightly', scriptId: 'linked-1' },
      { id: 'task-c', name: 'Other', scriptId: 'other-script' },
    ]
    const taskScheduler = new FakeTaskScheduler()
    const { container, app, taskRepository: tasks } = mountView(repo, new FakeScriptPicker(), new FakeFileScanner(), taskRepository, taskScheduler)
    await flush()

    ;(container.querySelector('[data-testid="delete-script-linked-1"]') as HTMLElement).click()
    await flush()
    ;(container.querySelector('[data-testid="confirm-delete-btn"]') as HTMLElement).click()
    await flush()

    expect(tasks.items.map((t) => t.id).sort()).toEqual(['task-c'])
    expect(taskScheduler.deletes.sort()).toEqual(['task-a', 'task-b'])
    expect(repo.items).toHaveLength(0)

    app.unmount()
  })

  it('keeps the script when deleting a linked task fails on the scheduler', async () => {
    const repo = new FakeScriptRepository([{
      id: 'linked-1', name: 'linked.py', path: 'C:/linked.py', type: 'python',
      createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
    }])
    const taskRepository = new FakeTaskRepository()
    taskRepository.items = [{ id: 'task-a', name: 'Backup', scriptId: 'linked-1' }]
    const taskScheduler = new FakeTaskScheduler()
    taskScheduler.error = 'ERROR: Access is denied.'
    const { container, app } = mountView(repo, new FakeScriptPicker(), new FakeFileScanner(), taskRepository, taskScheduler)
    await flush()

    ;(container.querySelector('[data-testid="delete-script-linked-1"]') as HTMLElement).click()
    await flush()
    ;(container.querySelector('[data-testid="confirm-delete-btn"]') as HTMLElement).click()
    await flush()

    expect(repo.items).toHaveLength(1)
    expect(container.querySelector('[data-testid="delete-error"]')?.textContent).toContain('Access is denied')
    app.unmount()
  })

  it('marks missing paths on mount and rechecks them on Refresh without deleting the script', async () => {
    const repo = new FakeScriptRepository([{
      id: 'missing-1',
      name: 'missing.py',
      path: 'C:/scripts/missing.py',
      type: 'python',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    }])
    let available = false
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp(ScriptsListView)
    app.provide(appContextKey, createAppContext({
      scriptRepository: repo as never,
      picker: new FakeScriptPicker() as never,
      scanner: new FakeFileScanner() as never,
      scriptPathChecker: { exists: async () => available },
      venvSync: new FakeVenvSync() as never,
    }))
    app.mount(container)
    await flush()

    expect(container.querySelector('[data-testid="missing-script-missing-1"]')).not.toBeNull()
    expect(repo.items).toHaveLength(1)

    available = true
    ;(container.querySelector('[data-testid="refresh-btn"]') as HTMLElement).click()
    await flush()

    expect(container.querySelector('[data-testid="missing-script-missing-1"]')).toBeNull()
    expect(repo.items).toHaveLength(1)

    app.unmount()
  })

  it('rejects a repair file when its name does not match and keeps the original path', async () => {
    const repo = new FakeScriptRepository([{
      id: 'repair-1', name: 'backup.py', path: 'C:/old/backup.py', type: 'python',
      createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
    }])
    const picker = new FakeScriptPicker()
    picker.fileResult = 'D:/new/other.py'
    const { container, app } = mountView(repo, picker, new FakeFileScanner(), new FakeTaskRepository(), new FakeTaskScheduler(), { exists: async () => false })
    await flush()

    ;(container.querySelector('[data-testid="repair-script-repair-1"]') as HTMLElement).click()
    await flush()

    expect(container.querySelector('[data-testid="repair-error"]')?.textContent).toContain('Script did not match')
    expect(repo.items[0].path).toBe('C:/old/backup.py')
    app.unmount()
  })

  it('updates the existing script path by id when the repair file name matches', async () => {
    const repo = new FakeScriptRepository([{
      id: 'repair-2', name: 'backup.py', path: 'C:/old/backup.py', type: 'python',
      createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
    }])
    const picker = new FakeScriptPicker()
    picker.fileResult = 'D:/new/backup.py'
    const taskRepository = new FakeTaskRepository()
    taskRepository.items = [{ id: 'task-repair-2', scriptId: 'repair-2' }]
    const taskScheduler = new FakeTaskScheduler()
    const { container, app } = mountView(repo, picker, new FakeFileScanner(), taskRepository, taskScheduler, { exists: async (path) => path === 'D:/new/backup.py' })
    await flush()

    ;(container.querySelector('[data-testid="repair-script-repair-2"]') as HTMLElement).click()
    await flush()

    expect(repo.items).toHaveLength(1)
    expect(repo.items[0].id).toBe('repair-2')
    expect(repo.items[0].path).toBe('D:/new/backup.py')
    expect(taskScheduler.updates).toEqual([{ taskId: 'task-repair-2', scriptPath: 'D:/new/backup.py' }])
    expect(container.querySelector('[data-testid="missing-script-repair-2"]')).toBeNull()
    app.unmount()
  })
})
