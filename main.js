const { app, BrowserWindow, screen, ipcMain, Tray, Menu, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { exec } = require('child_process');

let mainWindow;
let tray = null;
let pendingUpdate = null;
let fullscreenInterval = null;
let wasOnTop = true;
let fullscreenStableCount = 0;
let isCurrentlyFullscreen = false;

const CURRENT_VERSION = app.getVersion();
const GITHUB_REPO = 'katrate/sticknotes';
const UPDATE_STATE_FILE = path.join(app.getPath('userData'), 'update-state.json');

function loadUpdateState() {
    try {
        if (fs.existsSync(UPDATE_STATE_FILE)) {
            return JSON.parse(fs.readFileSync(UPDATE_STATE_FILE, 'utf8'));
        }
    } catch {}
    return { downloadedVersion: null, downloadedPath: null };
}

function saveUpdateState(state) {
    try {
        fs.writeFileSync(UPDATE_STATE_FILE, JSON.stringify(state));
    } catch {}
}

function isNewerVersion(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) > (pb[i] || 0)) return true;
        if ((pa[i] || 0) < (pb[i] || 0)) return false;
    }
    return false;
}

function fetchJSON(urlPath) {
    return new Promise((resolve) => {
        https.get({
            hostname: 'api.github.com',
            path: urlPath,
            headers: { 'User-Agent': 'StickNotes-App' }
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch { resolve(null); }
            });
        }).on('error', () => resolve(null));
    });
}

function checkForUpdates() {
    return new Promise(async (resolve) => {
        const releases = await fetchJSON(`/repos/${GITHUB_REPO}/releases`);
        if (!Array.isArray(releases) || releases.length === 0) return resolve(null);

        let bestRelease = null;
        let bestVersion = CURRENT_VERSION;

        for (const release of releases) {
            const tagVersion = (release.tag_name || '').replace(/^v/, '');
            if (isNewerVersion(tagVersion, bestVersion)) {
                bestVersion = tagVersion;
                bestRelease = release;
            }
        }

        if (!bestRelease) return resolve(null);

        const platform = process.platform;
        let assetName = null;
        let downloadUrl = null;

        for (const asset of bestRelease.assets || []) {
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

        resolve({
            version: bestVersion,
            assetName,
            downloadUrl,
            releaseUrl: bestRelease.html_url
        });
    });
}

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
            '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
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

function downloadFile(url, dest, onDone, onErr) {
    const follow = (url) => {
        https.get(url, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                follow(res.headers.location);
                return;
            }
            const file = fs.createWriteStream(dest);
            res.pipe(file);
            file.on('finish', () => {
                file.close(onDone);
            });
            file.on('error', (err) => {
                fs.unlink(dest, () => {});
                onErr(err);
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => {});
            onErr(err);
        });
    };
    follow(url);
}

function launchInstaller(filePath) {
    if (process.platform === 'win32') {
        exec(`start "" "${filePath}"`, (err) => {
            if (err) {
                shell.openPath(filePath);
            }
        });
    } else {
        shell.openPath(filePath);
    }
}

function showUpdateNotification(updateInfo) {
    const state = loadUpdateState();

    if (state.downloadedVersion === updateInfo.version && state.downloadedPath && fs.existsSync(state.downloadedPath)) {
        const notif = new Notification({
            title: 'StickNotes Update Ready',
            body: `v${updateInfo.version} is downloaded. Click to install.`
        });
        notif.on('click', () => {
            launchInstaller(state.downloadedPath);
            setTimeout(() => app.quit(), 1000);
        });
        notif.show();
        return;
    }

    const notif = new Notification({
        title: 'StickNotes Update Available',
        body: `Version ${updateInfo.version} is available. Click to download.`,
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

    if (fs.existsSync(dest)) {
        new Notification({ title: 'StickNotes', body: 'Starting installer...' }).show();
        launchInstaller(dest);
        setTimeout(() => app.quit(), 1000);
        return;
    }

    const notif = new Notification({
        title: 'StickNotes',
        body: `Downloading v${updateInfo.version}...`
    });
    notif.show();

    downloadFile(updateInfo.downloadUrl, dest, () => {
        saveUpdateState({ downloadedVersion: updateInfo.version, downloadedPath: dest });
        new Notification({ title: 'StickNotes', body: 'Download complete. Starting installer...' }).show();
        launchInstaller(dest);
        setTimeout(() => app.quit(), 1000);
    }, () => {
        new Notification({ title: 'StickNotes', body: 'Download failed. Try again.' }).show();
    });
}

function buildTrayMenu() {
    const settings = app.getLoginItemSettings();
    const state = loadUpdateState();
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
        if (state.downloadedVersion === pendingUpdate.version && state.downloadedPath && fs.existsSync(state.downloadedPath)) {
            items.push({
                label: `Install v${pendingUpdate.version}`,
                click: () => {
                    launchInstaller(state.downloadedPath);
                    setTimeout(() => app.quit(), 1000);
                }
            });
        } else {
            items.push({
                label: `Download v${pendingUpdate.version}`,
                click: () => downloadAndInstall(pendingUpdate)
            });
        }
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

    checkForUpdates().then((updateInfo) => {
        if (updateInfo) {
            pendingUpdate = updateInfo;
            buildTrayMenu();
            showUpdateNotification(updateInfo);
        }
    });
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
