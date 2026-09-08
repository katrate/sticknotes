const { app, BrowserWindow, screen, ipcMain, Tray, Menu, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { exec } = require('child_process');

let mainWindow;
let tray = null;
let pendingUpdate = null;
let fullscreenInterval = null;
let wasOnTop = false;

const CURRENT_VERSION = app.getVersion();
const GITHUB_REPO = 'katrate/sticknotes';

function checkForUpdates() {
    return new Promise((resolve) => {
        const options = {
            hostname: 'api.github.com',
            path: `/repos/${GITHUB_REPO}/releases/latest`,
            headers: { 'User-Agent': 'StickNotes-App' }
        };

        https.get(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const release = JSON.parse(data);
                    const latestVersion = release.tag_name.replace(/^v/, '');
                    if (isNewerVersion(latestVersion, CURRENT_VERSION)) {
                        const platform = process.platform;
                        let assetName = null;
                        let downloadUrl = null;
                        for (const asset of release.assets || []) {
                            if (platform === 'win32' && asset.name.endsWith('.exe')) {
                                assetName = asset.name;
                                downloadUrl = asset.browser_download_url;
                                break;
                            }
                            if (platform === 'darwin' && (asset.name.endsWith('.dmg') || asset.name.endsWith('.zip'))) {
                                assetName = asset.name;
                                downloadUrl = asset.browser_download_url;
                                break;
                            }
                            if (platform === 'linux' && (asset.name.endsWith('.AppImage') || asset.name.endsWith('.deb'))) {
                                assetName = asset.name;
                                downloadUrl = asset.browser_download_url;
                                break;
                            }
                        }
                        resolve({ version: latestVersion, assetName, downloadUrl, releaseUrl: release.html_url });
                    } else {
                        resolve(null);
                    }
                } catch {
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null));
    });
}

function isNewerVersion(latest, current) {
    const l = latest.split('.').map(Number);
    const c = current.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((l[i] || 0) > (c[i] || 0)) return true;
        if ((l[i] || 0) < (c[i] || 0)) return false;
    }
    return false;
}

function detectFullscreen() {
    return new Promise((resolve) => {
        if (process.platform !== 'win32') return resolve(false);

        const ps = [
            'Add-Type -AssemblyName System.Windows.Forms',
            'Add-Type -AssemblyName System.Drawing',
            'Add-Type -TypeDefinition "',
            'using System;using System.Runtime.InteropServices;',
            'public class Win {',
            '  [DllImport(\\"user32.dll\\")] public static extern IntPtr GetForegroundWindow();',
            '  [DllImport(\\"user32.dll\\")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
            '  [DllImport(\\"user32.dll\\", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);',
            '  [DllImport(\\"user32.dll\\")] public static extern bool IsZoomed(IntPtr h);',
            '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }',
            '}"',
            ';',
            '$h = [Win]::GetForegroundWindow()',
            'if ([Win]::IsZoomed($h)) {',
            '  $r = New-Object Win+RECT',
            '  [Win]::GetWindowRect($h, [ref]$r) | Out-Null',
            '  $sb = New-Object System.Text.StringBuilder 256',
            '  [Win]::GetWindowText($h, $sb, 256) | Out-Null',
            '  $w = $r.R - $r.L; $hh = $r.B - $r.T',
            '  $scr = [System.Windows.Forms.Screen]::FromRectangle([System.Drawing.Rectangle]::FromLTRB($r.L,$r.T,$r.R,$r.B)).Bounds',
            '  if ($w -ge $scr.Width -and $hh -ge $scr.Height) { exit 0 }',
            '}',
            'exit 1'
        ].join('\n');

        const child = exec(
            `powershell -NoProfile -STA -Command "${ps.replace(/"/g, '\\"')}"`,
            { timeout: 3000, windowsHide: true },
            (err) => {
                // exit 0 = fullscreen found, exit 1 = no fullscreen
                resolve(err ? false : true);
            }
        );
    });
}

function showUpdateNotification(updateInfo) {
    const notif = new Notification({
        title: 'StickNotes Update Available',
        body: `Version ${updateInfo.version} is available. Click to update.`,
        silent: false
    });
    notif.on('click', () => {
        if (updateInfo.downloadUrl) {
            downloadAndInstall(updateInfo);
        } else {
            shell.openExternal(updateInfo.releaseUrl);
        }
    });
    notif.show();
}

function downloadAndInstall(updateInfo) {
    if (!updateInfo.downloadUrl) {
        shell.openExternal(updateInfo.releaseUrl);
        return;
    }

    const dest = path.join(app.getPath('downloads'), updateInfo.assetName);

    const notif = new Notification({
        title: 'StickNotes',
        body: `Downloading ${updateInfo.assetName}...`
    });
    notif.show();

    const file = fs.createWriteStream(dest);
    https.get(updateInfo.downloadUrl, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
            https.get(response.headers.location, (res2) => {
                res2.pipe(file);
                file.on('finish', () => {
                    file.close();
                    new Notification({ title: 'StickNotes', body: 'Download complete. Starting installer...' }).show();
                    shell.openPath(dest);
                    setTimeout(() => app.quit(), 1000);
                });
            }).on('error', (err) => {
                fs.unlink(dest, () => {});
                new Notification({ title: 'StickNotes', body: 'Download failed.' }).show();
            });
            return;
        }
        response.pipe(file);
        file.on('finish', () => {
            file.close();
            new Notification({ title: 'StickNotes', body: 'Download complete. Starting installer...' }).show();
            shell.openPath(dest);
            setTimeout(() => app.quit(), 1000);
        });
    }).on('error', (err) => {
        fs.unlink(dest, () => {});
        new Notification({ title: 'StickNotes', body: 'Download failed.' }).show();
    });
}

function buildTrayMenu() {
    const settings = app.getLoginItemSettings();
    const items = [
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
        { type: 'separator' }
    ];

    if (pendingUpdate) {
        items.push({
            label: `Update to v${pendingUpdate.version}`,
            click: () => {
                if (pendingUpdate.downloadUrl) {
                    downloadAndInstall(pendingUpdate);
                } else {
                    shell.openExternal(pendingUpdate.releaseUrl);
                }
            }
        });
        items.push({ type: 'separator' });
    }

    items.push({ label: 'Quit App', click: () => app.quit() });
    tray.setContextMenu(Menu.buildFromTemplate(items));
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

    // Keep behind full-screen apps on Windows by polling for fullscreen windows
    if (process.platform === 'win32') {
        fullscreenInterval = setInterval(() => {
            detectFullscreen().then((isFullscreen) => {
                if (!mainWindow || mainWindow.isDestroyed()) return;
                if (isFullscreen && !wasOnTop) {
                    wasOnTop = true;
                    mainWindow.setAlwaysOnTop(false);
                } else if (!isFullscreen && wasOnTop) {
                    wasOnTop = false;
                    mainWindow.setAlwaysOnTop(true, 'screen-saver');
                }
            });
        }, 2000);
    }

    mainWindow.loadFile('index.html');

    // Click-through logic
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
    ipcMain.on('set-ignore-mouse', (event, ignore) => {
        if (mainWindow) mainWindow.setIgnoreMouseEvents(ignore, { forward: true });
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

    // Check for updates on startup
    checkForUpdates().then((updateInfo) => {
        if (updateInfo) {
            pendingUpdate = updateInfo;
            buildTrayMenu();
            showUpdateNotification(updateInfo);
        }
    });
}

// Enable autostart by default on first launch
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
