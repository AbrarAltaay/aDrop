import { contextBridge, ipcRenderer } from "electron";
import type { AppApi, CopyProgress, CopyRequest, CopyResult, EnsurePreviewsRequest, EnsurePreviewsResult, InitialPaths, RecalculateRequest, RecalculateResult, ScanProgress, ScanResult } from "../common/types.js";

const api: AppApi = {
  getInitialPaths: () => ipcRenderer.invoke("app:get-initial-paths") as Promise<InitialPaths>,
  chooseDirectory: () => ipcRenderer.invoke("dialog:choose-directory") as Promise<string | null>,
  scanSource: (source: string, gapMinutes: number) => ipcRenderer.invoke("importer:scan-source", source, gapMinutes) as Promise<ScanResult>,
  recalculateBatches: (request: RecalculateRequest) => ipcRenderer.invoke("importer:recalculate-batches", request) as Promise<RecalculateResult>,
  ensurePreviews: (request: EnsurePreviewsRequest) => ipcRenderer.invoke("importer:ensure-previews", request) as Promise<EnsurePreviewsResult>,
  startCopy: (request: CopyRequest) => ipcRenderer.invoke("importer:start-copy", request) as Promise<CopyResult>,
  cancelCopy: () => ipcRenderer.invoke("importer:cancel-copy") as Promise<void>,
  onScanProgress: (callback: (progress: ScanProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ScanProgress) => callback(progress);
    ipcRenderer.on("scan-progress", listener);
    return () => ipcRenderer.off("scan-progress", listener);
  },
  onCopyProgress: (callback: (progress: CopyProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: CopyProgress) => callback(progress);
    ipcRenderer.on("copy-progress", listener);
    return () => ipcRenderer.off("copy-progress", listener);
  }
};

contextBridge.exposeInMainWorld("abrarImporter", api);
