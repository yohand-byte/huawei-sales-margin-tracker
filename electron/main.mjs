import { app, BrowserWindow, Notification, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_TITLE = 'Huawei Sales Manager';
const DEFAULT_START_URL = 'https://yohand-byte.github.io/huawei-sales-margin-tracker/';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const POLL_INTERVAL_MS = 12_000;
const STATE_FILENAME = 'sm-desktop-state.json';

let mainWindow = null;
let pollTimer = null;
let desktopConfig = null;
let desktopState = { lastNotifiedMessageId: null };

const readDesktopState = () => {
  try {
    const filePath = path.join(app.getPath('userData'), STATE_FILENAME);
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      desktopState = {
        lastNotifiedMessageId: typeof parsed.lastNotifiedMessageId === 'string' ? parsed.lastNotifiedMessageId : null,
      };
    }
  } catch {
    // ignore
  }
};

const writeDesktopState = () => {
  try {
    const filePath = path.join(app.getPath('userData'), STATE_FILENAME);
    fs.writeFileSync(filePath, JSON.stringify(desktopState, null, 2));
  } catch {
    // ignore
  }
};

const fetchLatestChatMessage = async () => {
  if (!desktopConfig) {
    return null;
  }
  const { supabaseUrl, supabaseAnonKey, storeId, deviceId, messagesTable } = desktopConfig;
  if (!supabaseUrl || !supabaseAnonKey || !storeId) {
    return null;
  }

  const table = messagesTable || 'sales_margin_messages';
  const url = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/${table}` +
    `?select=id,author,body,device_id,created_at&store_id=eq.${encodeURIComponent(storeId)}` +
    `&order=created_at.desc&limit=1`;

  const response = await fetch(url, {
    headers: {
      apikey: supabaseAnonKey,
      authorization: `Bearer ${supabaseAnonKey}`,
      'x-store-id': storeId,
    },
  });
  if (!response.ok) {
    return null;
  }
  const rows = await response.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || typeof row !== 'object') {
    return null;
  }
  if (deviceId && row.device_id === deviceId) {
    return null;
  }
  return row;
};

const showDesktopNotification = (title, body, url) => {
  try {
    const notification = new Notification({
      title,
      body,
    });
    notification.on('click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
        if (url) {
          void mainWindow.loadURL(url);
        }
      }
    });
    notification.show();
  } catch {
    // ignore
  }
};

const pollChatLoop = async () => {
  if (!desktopConfig || !mainWindow) {
    return;
  }
  try {
    const row = await fetchLatestChatMessage();
    if (!row || !row.id) {
      return;
    }
    if (desktopState.lastNotifiedMessageId === row.id) {
      return;
    }
    desktopState.lastNotifiedMessageId = row.id;
    writeDesktopState();

    // Avoid spamming while the window is focused.
    if (mainWindow.isFocused()) {
      return;
    }
    const author = String(row.author || 'Message');
    const body = String(row.body || '').slice(0, 240);
    const notifTitle = `${author} • Chat`;
    showDesktopNotification(notifTitle, body, DEFAULT_START_URL);
  } catch {
    // ignore
  }
};

const setDesktopPollingEnabled = (enabled) => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (!enabled) {
    return;
  }
  // Poll immediately then periodically.
  void pollChatLoop();
  pollTimer = setInterval(() => void pollChatLoop(), POLL_INTERVAL_MS);
};

const createWindow = async () => {
  const startUrl = process.env.ELECTRON_START_URL?.trim() || DEFAULT_START_URL;

  const win = new BrowserWindow({
    title: APP_TITLE,
    width: 1360,
    height: 860,
    backgroundColor: '#0b1324',
    show: false,
    webPreferences: {
      // Keep it simple: we are effectively a secure web wrapper.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.mjs'),
    },
  });

  mainWindow = win;

  // Make sure the embedded web app can request notifications/microphone in the wrapper.
  win.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'notifications' || permission === 'media' || permission === 'microphone') {
      callback(true);
      return;
    }
    callback(false);
  });

  win.webContents.session.setPermissionCheckHandler((_webContents, permission) => {
    if (permission === 'notifications' || permission === 'media' || permission === 'microphone') {
      return true;
    }
    return false;
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  // Open external links in the default browser (avoid random popups in-app).
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    // Stay inside the app for our origin, otherwise open externally.
    if (!url.startsWith(DEFAULT_START_URL) && !url.startsWith('http://localhost:')) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  await win.loadURL(startUrl);
};

ipcMain.handle('sm:set-config', (_event, config) => {
  desktopConfig = config && typeof config === 'object' ? config : null;
  return { ok: Boolean(desktopConfig) };
});

ipcMain.handle('sm:set-notifications-enabled', (_event, enabled) => {
  setDesktopPollingEnabled(Boolean(enabled));
  return { ok: true, enabled: Boolean(enabled) };
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

app.whenReady()
  .then(() => {
    readDesktopState();
    return createWindow();
  })
  .catch(() => {
    app.quit();
  });
