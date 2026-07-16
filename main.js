'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path   = require('path');
const { startServer, setProjectFolder } = require('./server');

let mainWindow = null;
let serverInstance = null;
const PORT = 7890;

async function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 900,
        minHeight: 600,
        title: 'QC Lite',
        icon: path.join(__dirname, 'ui', 'assets', 'logo.png'),
        backgroundColor: '#1a1a2e',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
    // mainWindow.webContents.openDevTools(); // uncomment for dev
}

// ── IPC: open folder dialog ───────────────────────────────────────────────────
ipcMain.handle('open-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Project Folder',
        properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths.length) return null;

    const folder = result.filePaths[0];
    setProjectFolder(folder);
    return folder;
});

// ── startup ───────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
    try {
        serverInstance = await startServer(PORT);
        console.log(`[QC Lite] Server running on port ${PORT}`);
    } catch (e) {
        console.error('[QC Lite] Server start failed:', e);
    }
    await createWindow();
});

app.on('window-all-closed', () => {
    // On macOS keep the app running in the dock until the user quits explicitly.
    if (process.platform === 'darwin') {
        mainWindow = null;
        return;
    }
    app.quit();
});

app.on('before-quit', () => {
    if (serverInstance) {
        serverInstance.close();
        serverInstance = null;
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
