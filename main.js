'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const { candidateRoots } = require('./src/discover');
const { Recorder } = require('./src/recorder');
const { buildHar, parseHar } = require('./src/har');

let win = null;
let roots = [];
let settings = { extraRoots: [], disabledRoots: [] };
let detectedRoots = [];
let viewKey = null;
let importSeq = 0;
const imports = new Map(); // id -> { id, name, sessions: ImportedSession[] }

const userFile = (n) => path.join(app.getPath('userData'), n);

function loadSettings() {
  try { settings = { extraRoots: [], disabledRoots: [], ...JSON.parse(fs.readFileSync(userFile('settings.json'), 'utf8')) }; } catch { /* defaults */ }
}
function saveSettings() {
  try { fs.writeFileSync(userFile('settings.json'), JSON.stringify(settings, null, 2)); } catch { /* ignore */ }
}
function refreshRoots() {
  detectedRoots = candidateRoots(settings.extraRoots);
  roots = detectedRoots.filter((r) => !settings.disabledRoots.includes(r));
}
const rootsInfo = () => ({ roots: detectedRoots, enabled: roots, extraRoots: settings.extraRoots });

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const recorder = new Recorder({
  getRoots: () => roots,
  onChange: (changed) => {
    send('state', state());
    if (viewKey && changed.has(viewKey)) {
      const v = view(viewKey);
      if (v) send('view:update', { key: viewKey, info: v.info(), calls: v.calls() });
    }
  },
});

/** Uniform view over a recorded session (captured calls only) or an imported one. */
function view(key) {
  if (!key) return null;
  if (key.startsWith('imp')) {
    for (const imp of imports.values()) {
      const s = imp.sessions.find((x) => x.key === key);
      if (s) return { info: () => s.info(), calls: () => s.calls(), detail: (id) => s.detail(id), imported: s };
    }
    return null;
  }
  const s = recorder.sessions.get(key);
  if (!s) return null;
  return { info: () => s.info(), calls: () => recorder.captured(s), detail: (id) => s.detail(id), session: s };
}

function state() {
  return {
    recording: recorder.recording,
    windows: recorder.windows,
    roots,
    sessions: recorder.summaries(),
    imports: [...imports.values()].map((imp) => ({
      id: imp.id, name: imp.name,
      sessions: imp.sessions.map((s) => {
        const info = s.info();
        const calls = s.calls();
        return { key: s.key, title: info.title, cwd: info.cwd, count: calls.length, errors: calls.filter((c) => c.statusClass === 'error').length };
      }),
    })),
  };
}

// ---------- HAR ----------

function harFor(scope) {
  if (scope === 'recording') {
    return buildHar([...recorder.sessions.values()].map((s) => ({ info: s.info(), calls: recorder.captured(s), detail: (id) => s.detail(id) })));
  }
  const v = view(scope);
  if (!v) throw new Error('Nothing to export');
  if (v.imported) {
    const s = v.imported;
    return { log: { version: '1.2', creator: { name: 'cLogs', version: app.getVersion() }, pages: s.page ? [s.page] : [], entries: s.entries } };
  }
  return buildHar([{ info: v.info(), calls: v.calls(), detail: v.detail }]);
}

function writeHar(scope, file) {
  const har = harFor(scope);
  fs.writeFileSync(file, JSON.stringify(har, null, 1));
  return { file, entries: har.log.entries.length };
}

function importHarFile(file) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const id = `imp${++importSeq}`;
  const sessions = parseHar(json, path.basename(file), id);
  imports.set(id, { id, name: path.basename(file), sessions });
  return { id, sessions: sessions.length };
}

const stamp = () => new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('state', () => state());
  ipcMain.handle('rec:start', async () => { refreshRoots(); await recorder.start(); return state(); });
  ipcMain.handle('rec:stop', async () => { await recorder.stop(); return state(); });
  ipcMain.handle('rec:clear', async () => {
    await recorder.clear();
    if (viewKey && !viewKey.startsWith('imp')) viewKey = null;
    return state();
  });

  ipcMain.handle('view:open', (_e, key) => {
    viewKey = key;
    const v = view(key);
    return v ? { key, info: v.info(), calls: v.calls() } : null;
  });
  ipcMain.handle('view:close', () => { viewKey = null; });
  ipcMain.handle('call:detail', (_e, key, id) => {
    const v = view(key);
    return v ? v.detail(id) : null;
  });

  ipcMain.handle('har:export', async (_e, scope) => {
    const r = await dialog.showSaveDialog(win, {
      title: 'Export HAR',
      defaultPath: `clogs-${stamp()}.har`,
      filters: [{ name: 'HAR', extensions: ['har', 'json'] }],
    });
    if (r.canceled || !r.filePath) return null;
    return writeHar(scope, r.filePath);
  });
  ipcMain.handle('har:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Import HAR', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'HAR', extensions: ['har', 'json'] }],
    });
    if (r.canceled) return state();
    for (const f of r.filePaths) {
      try { importHarFile(f); } catch (e) { dialog.showErrorBox('Import failed', `${path.basename(f)}: ${e.message}`); }
    }
    return state();
  });
  ipcMain.handle('har:remove', (_e, id) => {
    imports.delete(id);
    if (viewKey && viewKey.startsWith(`${id}:`)) viewKey = null;
    return state();
  });

  ipcMain.handle('roots:list', () => rootsInfo());
  ipcMain.handle('roots:toggle', async (_e, dir, on) => {
    settings.disabledRoots = settings.disabledRoots.filter((d) => d !== dir);
    if (!on) settings.disabledRoots.push(dir);
    saveSettings();
    await restartIfRecording();
    send('state', state());
    return rootsInfo();
  });
  ipcMain.handle('roots:add', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Add a Claude config directory (the folder that contains "projects")',
      properties: ['openDirectory', 'showHiddenFiles'],
    });
    if (r.canceled || !r.filePaths[0]) return rootsInfo();
    const dir = r.filePaths[0];
    if (!fs.existsSync(path.join(dir, 'projects'))) {
      await dialog.showMessageBox(win, { type: 'warning', message: 'No "projects" folder in that directory.', detail: 'Pick the Claude config directory itself, for example ~/.claude.' });
    } else if (!settings.extraRoots.includes(dir)) {
      settings.extraRoots.push(dir);
      saveSettings();
      await restartIfRecording();
    }
    return rootsInfo();
  });
  ipcMain.handle('roots:remove', async (_e, dir) => {
    settings.extraRoots = settings.extraRoots.filter((d) => d !== dir);
    saveSettings();
    await restartIfRecording();
    return rootsInfo();
  });
  ipcMain.handle('file:reveal', (_e, key) => {
    if (recorder.sessions.has(key)) shell.showItemInFolder(key);
  });
}

async function restartIfRecording() {
  refreshRoots();
  if (recorder.recording) { await recorder.stop(); await recorder.start(); }
}

// ---------- window ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 560,
    title: 'cLogs',
    backgroundColor: '#16171a',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; viewKey = null; });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const toggle = () => (recorder.recording ? recorder.stop() : (refreshRoots(), recorder.start()));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Import HAR…', accelerator: 'CmdOrCtrl+O', click: () => send('menu', 'import') },
        { label: 'Export recording as HAR…', accelerator: 'CmdOrCtrl+S', click: () => send('menu', 'export') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Recording',
      submenu: [
        { label: 'Start / Stop', accelerator: 'CmdOrCtrl+E', click: toggle },
        { label: 'Clear', accelerator: 'CmdOrCtrl+K', click: () => send('menu', 'clear') },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]));
}

if (process.env.CALLS_SMOKE_OUT) {
  require('./src/smoke')(app, process.env.CALLS_SMOKE_OUT, { writeHar, importHarFile, state });
}

app.whenReady().then(async () => {
  loadSettings();
  refreshRoots();
  if (process.platform === 'darwin' && !app.isPackaged) app.dock.setIcon(path.join(__dirname, 'build', 'icon.png'));
  registerIpc();
  buildMenu();
  createWindow();
  // Like DevTools, start recording as soon as the app opens.
  const since = Number(process.env.CALLS_SMOKE_SINCE) || undefined;
  await recorder.start({ since });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  recorder.stop();
  if (process.platform !== 'darwin') app.quit();
});
