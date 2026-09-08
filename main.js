const { app, BrowserWindow, screen, ipcMain, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

let mainWindow;
let tray = null;
let fullscreenInterval = null;
let fullscreenStableCount = 0;
let isCurrentlyFullscreen = false;

function detectFullscreen() {
    return new Promise((resolve) => {
        if (process.platform !== 'win32') return resolve(false);

        const ps = [
            'Add-Type -TypeDefinition @"',
            'using System;using System.Runtime.InteropServices;',
            'public class WinAPI {',
            '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
            '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
            '  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);',
            '  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);',
            '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }',
            '}',
            '"@',
            '$h = [WinAPI]::GetForegroundWindow()',
            '$style = [WinAPI]::GetWindowLong($h, -16)',
            '$hasCaption = ($style -band 0x00C00000) -ne 0',
            'if (-not $hasCaption) {',
            '  $r = New-Object WinAPI+RECT',
            '  [WinAPI]::GetWindowRect($h, [ref]$r) | Out-Null',
            '  $ww = [WinAPI]::GetSystemMetrics(0)',
            '  $wh = [WinAPI]::GetSystemMetrics(1)',
            '  $w = $r.R - $r.L; $hh = $r.B - $r.T',
            '  if ($w -ge $ww -and $hh -ge $wh) { exit 0 }',
            '}',
            'exit 1'
        ].join('`n');

        exec(
            `powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`,
            { timeout: 3000, windowsHide: true },
            (err) => resolve(err ? false : true)
        );
    });
}

function updateFullscreenState() {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    detectFullscreen().then((detected) => {
        if (detected) {
            fullscreenStableCount++;
            if (fullscreenStableCount >= 3 && !isCurrentlyFullscreen) {
                isCurrentlyFullscreen = true;
                mainWindow.setAlwaysOnTop(false);
            }
        } else {
            fullscreenStableCount = 0;
            if (isCurrentlyFullscreen) {
                isCurrentlyFullscreen = false;
                mainWindow.setAlwaysOnTop(true, 'screen-saver');
            }
        }
    });
}

function buildTrayMenu() {
    const settings = app.getLoginItemSettings();
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Open Notes', click: () => mainWindow.show() },
        { type: 'separator' },
        {
            label: 'Run on Startup',
            type: 'checkbox',
            checked: settings.openAtLogin,
            click: (menuItem) => {
                app.setLoginItemSettings({ openAtLogin: menuItem.checked });
            }
        },
        { type: 'separator' },
        { label: 'Quit App', click: () => app.quit() }
    ]));
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
        alwaysOnTop: process.platform === 'win32' ? 'screen-saver' : true,
        visibleOnAllWorkspaces: true,
        skipTaskbar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile('index.html');

    if (process.platform === 'win32') {
        fullscreenInterval = setInterval(updateFullscreenState, 2000);
    }

    mainWindow.setIgnoreMouseEvents(true, { forward: true });
    ipcMain.on('set-ignore-mouse', (event, ignore) => {
        if (mainWindow) mainWindow.setIgnoreMouseEvents(ignore, { forward: true });
    });

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

if (!fs.existsSync(path.join(app.getPath('userData'), '.autostart-configured'))) {
    app.setLoginItemSettings({ openAtLogin: true });
    fs.writeFileSync(path.join(app.getPath('userData'), '.autostart-configured'), '1');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', (e) => {
    e.preventDefault();
});

app.on('before-quit', () => {
    if (fullscreenInterval) clearInterval(fullscreenInterval);
});
