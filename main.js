const { app, BrowserWindow, screen, ipcMain, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
let tray = null;

function createWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;

    mainWindow = new BrowserWindow({
        width: 450,
        height: height,
        x: width - 450,
        y: 0,
        frame: false,
        transparent: true,
        alwaysOnTop: true, // Survive Win + D
        skipTaskbar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile('index.html');

    // Click-through logic
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
    ipcMain.on('set-ignore-mouse', (event, ignore) => {
        if (mainWindow) mainWindow.setIgnoreMouseEvents(ignore, { forward: true });
    });

    // TRAY SETUP - Wrapped in a check so it doesn't crash
    const iconPath = path.join(__dirname, 'icon.png');

    if (fs.existsSync(iconPath)) {
        tray = new Tray(iconPath);
        const contextMenu = Menu.buildFromTemplate([
            { label: 'Open Notes', click: () => mainWindow.show() },
            { type: 'separator' },
            { label: 'Quit App', click: () => app.quit() }
        ]);
        tray.setToolTip('Edge Notes');
        tray.setContextMenu(contextMenu);
        tray.on('click', () => {
            mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
        });
    } else {
        console.log("WARNING: icon.png not found. Skipping System Tray setup.");
    }
}

app.setLoginItemSettings({ openAtLogin: true });

app.whenReady().then(createWindow);

// Keep app alive even if window is hidden
app.on('window-all-closed', (e) => {
    e.preventDefault();
});