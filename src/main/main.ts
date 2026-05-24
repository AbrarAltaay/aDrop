import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { cancelCopy, ensurePreviews, findDefaultDropbox, findLikelySdCard, recalculateBatches, scanSource, startCopy } from "./importer.js";
import { APP_NAME } from "../common/types.js";
import type { CopyRequest, EnsurePreviewsRequest, RecalculateRequest } from "../common/types.js";

let mainWindow: BrowserWindow | null = null;
app.setName(APP_NAME);

function isLocalAppUrl(url: string, devServerUrl?: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") return true;
    if (!devServerUrl) return false;
    const devParsed = new URL(devServerUrl);
    return parsed.origin === devParsed.origin && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  } catch {
    return false;
  }
}

function isAllowedExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostAllowed = parsed.hostname === "instagram.com" || parsed.hostname === "www.instagram.com";
    const pathAllowed = parsed.pathname === "/AbrarAltaay" || parsed.pathname === "/AbrarAltaay/";
    return parsed.protocol === "https:" && hostAllowed && pathAllowed;
  } catch {
    return false;
  }
}

function sendToRenderer(channel: string, payload: unknown): void {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  } catch {
    // The window can close while a scan/copy worker is finishing a progress tick.
  }
}

function createWindow(): void {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: APP_NAME,
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", event => {
    const targetUrl = event.url;
    if (isLocalAppUrl(targetUrl, devServerUrl)) return;
    event.preventDefault();
    if (isAllowedExternalUrl(targetUrl)) {
      void shell.openExternal(targetUrl);
    }
  });

  if (devServerUrl && isLocalAppUrl(devServerUrl, devServerUrl)) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("app:get-initial-paths", async () => ({
  source: await findLikelySdCard(),
  dropbox: await findDefaultDropbox()
}));

ipcMain.handle("dialog:choose-directory", async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Choose folder"
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle("importer:scan-source", async (_event, source: string, gapMinutes: number) => {
  const tempRoot = path.join(app.getPath("temp"), "abrar-photo-importer-previews");
  const cacheDir = path.join(app.getPath("userData"), "metadata-cache");
  return scanSource(source, gapMinutes, tempRoot, cacheDir, progress => {
    sendToRenderer("scan-progress", progress);
  });
});

ipcMain.handle("importer:recalculate-batches", async (_event, request: RecalculateRequest) => {
  const tempRoot = path.join(app.getPath("temp"), "abrar-photo-importer-previews");
  return recalculateBatches(request, tempRoot, progress => {
    sendToRenderer("scan-progress", progress);
  });
});

ipcMain.handle("importer:ensure-previews", async (_event, request: EnsurePreviewsRequest) => {
  const tempRoot = path.join(app.getPath("temp"), "abrar-photo-importer-previews");
  return ensurePreviews(request, tempRoot, progress => {
    sendToRenderer("scan-progress", progress);
  });
});

ipcMain.handle("importer:start-copy", async (_event, request: CopyRequest) => {
  return startCopy(request, progress => {
    sendToRenderer("copy-progress", progress);
  });
});

ipcMain.handle("importer:cancel-copy", async () => {
  cancelCopy();
});
