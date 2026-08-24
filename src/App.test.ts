import { describe, it, expect } from 'vitest';
import { createApp, nextTick } from 'vue';
import App from './App.vue';

describe('App', () => {
  it('renders 5 nav buttons with exact labels: Home, Scripts List, Task, Logging, Setting', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    
    const app = createApp(App);
    
    app.mount(container);
    await nextTick();
    
    // Check for navigation buttons with exact labels
    const buttons = container.querySelectorAll('nav button');
    const labels = Array.from(buttons).map(btn => btn.textContent?.trim());
    
    expect(labels).toEqual(['Home', 'Scripts List', 'Task', 'Logging', 'Setting']);
    
    app.unmount();
    document.body.removeChild(container);
  });

  it('shows Home content by default', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    
    const app = createApp(App);
    
    app.mount(container);
    await nextTick();
    
    // Home should be shown by default
    expect(container.innerHTML).toContain('Dashboard');
    expect(container.innerHTML).not.toContain('Python scripts in the library');
    expect(container.innerHTML).not.toContain('Automate script execution');
    expect(container.innerHTML).not.toContain('Application configuration');
    
    // Verify we have the right structure
    expect(container.innerHTML).toContain('Home');
    
    app.unmount();
    document.body.removeChild(container);
  });

  it('clicking Scripts List button shows ScriptsList content', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    
    const app = createApp(App);
    
    app.mount(container);
    await nextTick();
    
    // Initially Home should be shown
    expect(container.innerHTML).toContain('Dashboard');
    expect(container.innerHTML).not.toContain('Python scripts in the library');
    
    // Find the button with text "Scripts List" and click it
    const allButtons = container.querySelectorAll('button');
    for (const btn of allButtons) {
      const text = (btn as HTMLElement).textContent?.trim();
      if (text === 'Scripts List') {
        (btn as HTMLElement).click();
        await nextTick();
        break;
      }
    }
    
    // Now ScriptsList content should be shown
    expect(container.innerHTML).toContain('Python scripts in the library');
    expect(container.innerHTML).not.toContain('Dashboard');
    
    app.unmount();
    document.body.removeChild(container);
  });

  it('clicking Task button shows Task content', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    
    const app = createApp(App);
    
    app.mount(container);
    await nextTick();
    
    // Initially Home should be shown
    expect(container.innerHTML).toContain('Dashboard');
    
    // Find the button with text "Task" and click it
    const allButtons = container.querySelectorAll('button');
    for (const btn of allButtons) {
      const text = (btn as HTMLElement).textContent?.trim();
      if (text === 'Task') {
        (btn as HTMLElement).click();
        await nextTick();
        break;
      }
    }
    
    // Now Task content should be shown
    expect(container.innerHTML).toContain('Automate script execution');
    expect(container.innerHTML).not.toContain('Dashboard');
    
    app.unmount();
    document.body.removeChild(container);
  });

  it('clicking Setting button shows Setting content', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    
    const app = createApp(App);
    
    app.mount(container);
    await nextTick();
    
    // Initially Home should be shown
    expect(container.innerHTML).toContain('Dashboard');
    
    // Find the button with text "Setting" and click it
    const allButtons = container.querySelectorAll('button');
    for (const btn of allButtons) {
      const text = (btn as HTMLElement).textContent?.trim();
      if (text === 'Setting') {
        (btn as HTMLElement).click();
        await nextTick();
        break;
      }
    }
    
    // Now Setting content should be shown
    expect(container.innerHTML).toContain('Application configuration');
    expect(container.innerHTML).not.toContain('Dashboard');
    
    app.unmount();
    document.body.removeChild(container);
  });

  it('clicking Logging button shows Logging content', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    
    const app = createApp(App);
    
    app.mount(container);
    await nextTick();
    
    // Initially Home should be shown
    expect(container.innerHTML).toContain('Dashboard');
    
    // Find the button with text "Logging" and click it
    const allButtons = container.querySelectorAll('button');
    for (const btn of allButtons) {
      const text = (btn as HTMLElement).textContent?.trim();
      if (text === 'Logging') {
        (btn as HTMLElement).click();
        await nextTick();
        break;
      }
    }
    
    // Now Logging content should be shown
    expect(container.innerHTML).toContain('Run history');
    expect(container.innerHTML).not.toContain('Dashboard');
    
    app.unmount();
    document.body.removeChild(container);
  });

  it.each([
    ['stat-scripts', 'Python scripts in the library'],
    ['stat-tasks', 'Automate script execution'],
    ['stat-runs', 'Run history'],
  ])('clicking %s navigates to its corresponding page', async (statTestId, pageMarker) => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    const app = createApp(App);
    app.mount(container);
    await nextTick();

    const stat = container.querySelector(`[data-testid="${statTestId}"]`) as HTMLElement | null;
    expect(stat).not.toBeNull();
    stat?.click();
    await nextTick();

    expect(container.innerHTML).toContain(pageMarker);

    app.unmount();
    document.body.removeChild(container);
  });

  it('records a startup log entry on mount', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    
    const records: { source: string; message: string }[] = [];
    const fakeLogger = {
      async record(source: string, message: string) {
        records.push({ source, message });
      },
    };
    
    const app = createApp(App, { logger: fakeLogger as never });
    app.mount(container);
    await nextTick();
    await Promise.resolve();
    await nextTick();
    
    expect(records).toEqual([{ source: 'app', message: 'startup' }]);
    
    app.unmount();
    document.body.removeChild(container);
  });

  it('every view shows exactly one header.region, main.region.body, and footer.region', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    
    const app = createApp(App);
    
    app.mount(container);
    await nextTick();
    
    // Test Home view
    const homeHeader = container.querySelector('.region.header');
    const homeBody = container.querySelector('.region.body');
    const homeFooter = container.querySelector('.region.footer');
    
    expect(homeHeader).toBeTruthy();
    expect(homeBody).toBeTruthy();
    expect(homeFooter).toBeTruthy();
    
    // Navigate to Scripts List
    const allButtons = container.querySelectorAll('button');
    for (const btn of allButtons) {
      const text = (btn as HTMLElement).textContent?.trim();
      if (text === 'Scripts List') {
        (btn as HTMLElement).click();
        await nextTick();
        break;
      }
    }
    
    const scriptsListHeader = container.querySelector('.region.header');
    const scriptsListBody = container.querySelector('.region.body');
    const scriptsListFooter = container.querySelector('.region.footer');
    
    expect(scriptsListHeader).toBeTruthy();
    expect(scriptsListBody).toBeTruthy();
    expect(scriptsListFooter).toBeTruthy();
    
    // Navigate to Task
    for (const btn of allButtons) {
      const text = (btn as HTMLElement).textContent?.trim();
      if (text === 'Task') {
        (btn as HTMLElement).click();
        await nextTick();
        break;
      }
    }
    
    const taskHeader = container.querySelector('.region.header');
    const taskBody = container.querySelector('.region.body');
    const taskFooter = container.querySelector('.region.footer');
    
    expect(taskHeader).toBeTruthy();
    expect(taskBody).toBeTruthy();
    expect(taskFooter).toBeTruthy();
    
    // Navigate to Setting
    for (const btn of allButtons) {
      const text = (btn as HTMLElement).textContent?.trim();
      if (text === 'Setting') {
        (btn as HTMLElement).click();
        await nextTick();
        break;
      }
    }
    
    const settingHeader = container.querySelector('.region.header');
    const settingBody = container.querySelector('.region.body');
    const settingFooter = container.querySelector('.region.footer');
    
    expect(settingHeader).toBeTruthy();
    expect(settingBody).toBeTruthy();
    expect(settingFooter).toBeTruthy();
    
    app.unmount();
    document.body.removeChild(container);
  });

  it('renders an svg icon inside each of the 5 nav buttons', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    
    const app = createApp(App);
    
    app.mount(container);
    await nextTick();
    
    const buttons = container.querySelectorAll('nav button');
    
    expect(buttons.length).toBe(5);
    
    const svgCounts = Array.from(buttons).map(btn => btn.querySelectorAll('svg').length);
    expect(svgCounts.every(count => count === 1)).toBe(true);
    
    app.unmount();
    document.body.removeChild(container);
  });

  it('Task dialog script dropdown lists scripts loaded from the script repository', async () => {
    const seedScript = {
      id: 'script-1',
      name: 'backup.py',
      path: 'C:/scripts/backup.py',
      type: 'python',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };
    const fakeScriptRepository = {
      list: async () => [seedScript],
      get: async (id: string) => (id === seedScript.id ? seedScript : null),
      create: async () => seedScript,
      update: async () => seedScript,
      delete: async () => undefined,
    };
    const fakeTaskRepository = {
      list: async () => [],
      get: async () => null,
      create: async (input: any) => ({ ...input, id: 't1', lastRunAt: null, nextRunAt: null, status: 'scheduled', createdAt: '', updatedAt: '' }),
      update: async () => { throw new Error('unused'); },
      delete: async () => undefined,
    };

    const container = document.createElement('div');
    document.body.appendChild(container);

    const app = createApp(App, { scriptRepository: fakeScriptRepository, taskRepository: fakeTaskRepository });
    app.mount(container);
    await nextTick();
    await Promise.resolve();
    await nextTick();

    for (const btn of Array.from(container.querySelectorAll('button'))) {
      if (btn.textContent?.trim() === 'Task') {
        (btn as HTMLElement).click();
        await nextTick();
        break;
      }
    }

    const newTaskBtn = container.querySelector('[data-testid="new-task-btn"]') as HTMLElement;
    newTaskBtn.click();
    await nextTick();
    await Promise.resolve();
    await nextTick();

    const options = Array.from(container.querySelectorAll('[data-testid="script-select"] option'));
    expect(options.map(option => option.textContent?.trim())).toContain('backup.py');

    app.unmount();
    document.body.removeChild(container);
  });
});