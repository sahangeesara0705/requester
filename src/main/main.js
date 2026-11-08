'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { sendHttpRequest, cancelHttpRequest } = require('./http');

app.setName('Requester');

const DATA_FILE = () => path.join(app.getPath('userData'), 'requester-data.json');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 900,
    minHeight: 560,
    title: 'Requester',
    backgroundColor: '#1b1d23',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Never let the app window navigate away; open external links in the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const send = (channel) => () => mainWindow && mainWindow.webContents.send('menu', channel);
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New Request', accelerator: 'CmdOrCtrl+N', click: send('new-request') },
        { label: 'New Collection', accelerator: 'CmdOrCtrl+Shift+N', click: send('new-collection') },
        { type: 'separator' },
        { label: 'Import…', accelerator: 'CmdOrCtrl+O', click: send('import') },
        { label: 'Export All…', click: send('export-all') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- IPC: storage ----------
ipcMain.handle('store:load', async () => {
  try {
    const text = await fs.promises.readFile(DATA_FILE(), 'utf8');
    return JSON.parse(text);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Keep a copy of an unreadable file instead of silently overwriting it.
      try {
        await fs.promises.copyFile(DATA_FILE(), DATA_FILE() + '.corrupt-' + Date.now());
      } catch (_) { /* ignore */ }
    }
    return null;
  }
});

let saveChain = Promise.resolve();
ipcMain.handle('store:save', (_e, data) => {
  // Serialize writes and write atomically (tmp file + rename).
  saveChain = saveChain.then(async () => {
    const file = DATA_FILE();
    const tmp = file + '.tmp';
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.promises.rename(tmp, file);
  }).catch((err) => console.error('Save failed:', err));
  return saveChain.then(() => true);
});

ipcMain.on('store:saveSync', (e, data) => {
  // Used when the window is closing so the last edits are never lost.
  try {
    const file = DATA_FILE();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(file + '.tmp', file);
    e.returnValue = true;
  } catch (err) {
    console.error('Sync save failed:', err);
    e.returnValue = false;
  }
});

ipcMain.handle('store:path', () => DATA_FILE());

// ---------- IPC: dialogs ----------
ipcMain.handle('dialog:saveJson', async (_e, { defaultName, data }) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Export',
    defaultPath: path.join(app.getPath('documents'), defaultName || 'requester-export.json'),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  await fs.promises.writeFile(res.filePath, JSON.stringify(data, null, 2), 'utf8');
  return { canceled: false, filePath: res.filePath };
});

ipcMain.handle('dialog:openJson', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Import',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (res.canceled || !res.filePaths.length) return { canceled: true };
  const text = await fs.promises.readFile(res.filePaths[0], 'utf8');
  return { canceled: false, text, filePath: res.filePaths[0] };
});

ipcMain.handle('dialog:pickFile', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { title: 'Choose file', properties: ['openFile'] });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('dialog:saveResponse', async (_e, { defaultName, base64 }) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Save response',
    defaultPath: path.join(app.getPath('downloads'), defaultName || 'response'),
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  await fs.promises.writeFile(res.filePath, Buffer.from(base64, 'base64'));
  return { canceled: false, filePath: res.filePath };
});

// ---------- IPC: HTTP ----------
ipcMain.handle('http:send', (_e, spec) => sendHttpRequest(spec));
ipcMain.handle('http:cancel', (_e, id) => cancelHttpRequest(id));

// ---------- lifecycle ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
