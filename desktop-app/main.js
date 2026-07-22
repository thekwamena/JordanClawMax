const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');
const http = require('http');
const { fork } = require('child_process');

const BRIDGE_PORT = process.env.PORT || 8787;

let mainWindow = null;
let bridgeProcess = null;

function corePathFor(isPackaged) {
  return isPackaged
    ? path.join(process.resourcesPath, 'app.asar', 'bridge-core', 'server.js')
    : path.join(__dirname, '..', 'bridge-server', 'server.js');
}

function startBridge() {
  return new Promise((resolve, reject) => {
    const bridgeEntry = path.join(__dirname, 'bridge', 'server.js');
    bridgeProcess = fork(bridgeEntry, [], {
      env: {
        ...process.env,
        PORT: String(BRIDGE_PORT),
        JCM_CORE_BRIDGE_PATH: corePathFor(app.isPackaged),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    bridgeProcess.stdout.on('data', (d) => process.stdout.write(`[bridge] ${d}`));
    bridgeProcess.stderr.on('data', (d) => process.stderr.write(`[bridge] ${d}`));
    bridgeProcess.on('error', reject);
    bridgeProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`Bridge server exited with code ${code}`);
      }
    });

    waitForHealth(resolve, reject, 0);
  });
}

function waitForHealth(resolve, reject, attempt) {
  if (attempt > 60) return reject(new Error('Bridge server did not become healthy in time'));
  http
    .get(`http://127.0.0.1:${BRIDGE_PORT}/api/health`, (res) => {
      if (res.statusCode === 200) resolve();
      else setTimeout(() => waitForHealth(resolve, reject, attempt + 1), 500);
    })
    .on('error', () => setTimeout(() => waitForHealth(resolve, reject, attempt + 1), 500));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0f0f14',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const uiEntry = app.isPackaged
    ? path.join(process.resourcesPath, 'app-ui', 'index.html')
    : path.join(__dirname, '..', 'build', 'index.html');

  mainWindow.loadFile(uiEntry, { search: `bridgePort=${BRIDGE_PORT}` });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const template = [
    {
      label: 'JordanClawMax',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
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

app.whenReady().then(async () => {
  buildMenu();
  try {
    await startBridge();
  } catch (err) {
    console.error('Failed to start bridge server:', err);
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (bridgeProcess) bridgeProcess.kill();
});
