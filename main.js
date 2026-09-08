const { app, BrowserWindow, screen, ipcMain, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
let tray = null;

function buildTrayMenu() {
    const settings = app.getLoginItemSettings();
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Open Notes', click: () => mainWindow.show() },
        { type: 'separator' },
        {
            label: 'Run on Startup',
            type: 'checkbox',
            checked: settings.openAtLogin,
            click: (menuItem) => {
                app.setLoginItemSettings({ openAtLogin: menuItem.checked });
                if (mainWindow) {
                    mainWindow.webContents.send('autostart-changed', menuItem.checked);
                }
            }
        },
        { type: 'separator' },
        { label: 'Quit App', click: () => app.quit() }
    ]);
    tray.setContextMenu(contextMenu);
}

function createWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;

    mainWindow = new BrowserWindow({
        width: 450,
        height: height,
        x: width - 450,
        y: 0,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
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

    // Autostart IPC
    ipcMain.handle('get-autostart', () => {
        return app.getLoginItemSettings().openAtLogin;
    });

    ipcMain.on('set-autostart', (event, enabled) => {
        app.setLoginItemSettings({ openAtLogin: enabled });
        buildTrayMenu();
    });

    // TRAY SETUP
    const iconPath = path.join(__dirname, 'icon.png');

    if (fs.existsSync(iconPath)) {
        tray = new Tray(iconPath);
        buildTrayMenu();
        tray.setToolTip('Edge Notes');
        tray.on('click', () => {
            mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
        });
    } else {
        console.log("WARNING: icon.png not found. Skipping System Tray setup.");
    }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', (e) => {
    e.preventDefault();
});