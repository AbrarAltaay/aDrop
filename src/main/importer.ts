import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import {
  APP_NAME,
  CopyDestination,
  CopyProgress,
  CopyRequest,
  CopyResult,
  DEFAULT_PRESET,
  EnsurePreviewsRequest,
  EnsurePreviewsResult,
  PARALLEL_COPY_WORKERS,
  PhotoItem,
  RecalculateRequest,
  RecalculateResult,
  ScanProgress,
  ScanResult,
  ShootItem
} from "../common/types.js";

const execFileAsync = promisify(execFile);
const EXIF_DATETIME_PATTERN = /(20\d{2}|19\d{2}):([01]\d):([0-3]\d) ([0-2]\d):([0-5]\d):([0-5]\d)/;
const QUICK_LOOK_SIZE = 220;
let copyCancelRequested = false;

interface CachedPhotoItem extends PhotoItem {
  mtimeMs: number;
}

interface MetadataCacheFile {
  source: string;
  updatedAt: string;
  photos: Record<string, CachedPhotoItem>;
}

export type ProgressSender<T> = (progress: T) => void;

export function cancelCopy(): void {
  copyCancelRequested = true;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function localIso(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseExifDate(text: string): Date | null {
  const match = text.match(EXIF_DATETIME_PATTERN);
  if (!match) return null;
  const [datePart, timePart] = match[0].split(" ");
  const [year, month, day] = datePart.split(":").map(Number);
  const [hour, minute, second] = timePart.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute, second);
}

function formatBytes(size: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  for (const unit of units) {
    if (value < 1024 || unit === units[units.length - 1]) {
      return unit === "B" ? `${Math.round(value)} ${unit}` : `${value.toFixed(1)} ${unit}`;
    }
    value /= 1024;
  }
  return `${size} B`;
}

function formatDuration(secondsInput: number): string {
  const seconds = Math.max(0, Math.floor(secondsInput));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(secs)}`;
  return `${minutes}:${pad(secs)}`;
}

function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return "0 B/s";
  return `${formatBytes(bytesPerSecond)}/s`;
}

function safeFolderName(value: string): string {
  const cleaned = value
    .normalize("NFKC")
    .trim()
    .replace(/[\u0000-\u001f\u007f:/\\]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+$/, "")
    .replace(/[. ]+$/g, "")
    .slice(0, 120);
  return cleaned || "Untitled_Shoot";
}

export function parseSubfolders(value: string): string[] {
  const folders = value.split(",").map(safeFolderName).filter(Boolean);
  return folders.length > 0 ? folders : DEFAULT_PRESET.split(",").map(safeFolderName);
}

function renamedCopyName(shootFolderName: string, sequence: number, originalPath: string): string {
  const base = safeFolderName(shootFolderName).replace(/\s+/g, "_");
  const ext = path.extname(originalPath).toUpperCase() || ".ARW";
  return `${base}_${String(sequence).padStart(4, "0")}${ext}`;
}

function defaultShootName(index: number, start: Date): string {
  return `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}_Shoot_${String(index).padStart(2, "0")}`;
}

function serializePhoto(filePath: string, captureDatetime: Date, size: number, timeSource: string): PhotoItem {
  return {
    path: filePath,
    name: path.basename(filePath),
    captureDatetime: localIso(captureDatetime),
    size,
    timeSource
  };
}

function serializeCachedPhoto(filePath: string, captureDatetime: Date, size: number, mtimeMs: number, timeSource: string): CachedPhotoItem {
  return {
    ...serializePhoto(filePath, captureDatetime, size, timeSource),
    mtimeMs
  };
}

function photoDateKey(photo: PhotoItem): string {
  return photo.captureDatetime.slice(0, 10);
}

function summarizeDates(photos: PhotoItem[]): string {
  const counts = new Map<string, number>();
  for (const photo of photos) {
    const dateKey = photoDateKey(photo);
    counts.set(dateKey, (counts.get(dateKey) ?? 0) + 1);
  }
  return [...counts.entries()].sort().map(([dateKey, count]) => `${dateKey} (${count})`).join(", ");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

function isArwPath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".arw";
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function safeJoin(parentPath: string, ...segments: string[]): string {
  const target = path.resolve(parentPath, ...segments);
  if (!isPathInside(parentPath, target)) {
    throw new Error("Refusing to write outside the selected destination folder.");
  }
  return target;
}

function safeFileName(value: string, fallback: string): string {
  const base = path.basename(value || fallback);
  return safeFolderName(base) || fallback;
}

async function assertRealPathInside(parentPath: string, childPath: string): Promise<void> {
  const realParent = await fs.realpath(parentPath);
  const realChild = await fs.realpath(childPath);
  if (!isPathInside(realParent, realChild)) {
    throw new Error("Refusing to follow a destination symlink outside the selected folder.");
  }
}

function sourceVolumeRoot(source: string): string {
  const resolved = path.resolve(source);
  const parts = resolved.split(path.sep).filter(Boolean);
  if (parts[0] === "Volumes" && parts[1]) return path.join(path.sep, parts[0], parts[1]);
  return resolved;
}

function assertDestinationIsNotSource(source: string, destination: string): void {
  if (!source) return;
  const protectedRoot = sourceVolumeRoot(source);
  if (isPathInside(protectedRoot, destination)) {
    throw new Error("Destination cannot be on the selected source/SD card. Choose a hard drive, Dropbox, or another safe folder.");
  }
}

function cachePathForSource(cacheDir: string, source: string): string {
  const hash = crypto.createHash("sha256").update(source).digest("hex").slice(0, 24);
  return path.join(cacheDir, `metadata-${hash}.json`);
}

async function loadMetadataCache(cacheDir: string, source: string): Promise<MetadataCacheFile> {
  const cachePath = cachePathForSource(cacheDir, source);
  try {
    const raw = await fs.readFile(cachePath, "utf-8");
    const parsed = JSON.parse(raw) as MetadataCacheFile;
    if (parsed.source === source && parsed.photos && typeof parsed.photos === "object") {
      return parsed;
    }
  } catch {
    // Cache misses and malformed cache files fall through to a fresh cache.
  }
  return { source, updatedAt: new Date().toISOString(), photos: {} };
}

async function saveMetadataCache(cacheDir: string, source: string, photos: CachedPhotoItem[]): Promise<void> {
  await fs.mkdir(cacheDir, { recursive: true });
  const cacheFile: MetadataCacheFile = {
    source,
    updatedAt: new Date().toISOString(),
    photos: Object.fromEntries(photos.map(photo => [photo.path, photo]))
  };
  await fs.writeFile(cachePathForSource(cacheDir, source), `${JSON.stringify(cacheFile, null, 2)}\n`, "utf-8");
}

export async function findLikelySdCard(): Promise<string> {
  const volumes = "/Volumes";
  if (!(await pathExists(volumes))) return "";
  const entries = await fs.readdir(volumes, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name === "Macintosh HD") continue;
    const dcim = path.join(volumes, entry.name, "DCIM");
    if (await pathExists(dcim)) return dcim;
  }
  return "";
}

export async function findDefaultDropbox(): Promise<string> {
  const home = os.homedir();
  const candidates = [
    path.join(home, "Dropbox"),
    path.join(home, "Library", "CloudStorage", "Dropbox")
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return "";
}

async function findArwPaths(source: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(folder: string): Promise<void> {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const entryPath = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".arw")) {
        results.push(entryPath);
      }
    }
  }
  await walk(source);
  return results.sort((a, b) => a.localeCompare(b));
}

async function readEmbeddedExifDate(filePath: string): Promise<Date | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let total = 0;
    const stream = createReadStream(filePath, { start: 0, end: 2 * 1024 * 1024 - 1 });
    stream.on("data", chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
      total += buffer.length;
      if (total >= 2 * 1024 * 1024) stream.destroy();
    });
    stream.on("error", () => resolve(null));
    stream.on("close", () => {
      const text = Buffer.concat(chunks).toString("ascii");
      resolve(parseExifDate(text));
    });
  });
}

async function readMdlsDate(filePath: string): Promise<{ date: Date; source: string } | null> {
  const keys = ["kMDItemAcquisitionDate", "kMDItemContentCreationDate", "kMDItemFSCreationDate"];
  for (const key of keys) {
    try {
      const { stdout } = await execFileAsync("mdls", ["-raw", "-name", key, filePath], { timeout: 5000 });
      const raw = stdout.trim();
      if (!raw || raw === "(null)") continue;
      const parsed = new Date(raw);
      if (!Number.isNaN(parsed.getTime())) {
        return { date: parsed, source: `mdls ${key}` };
      }
      const match = raw.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
      if (match) {
        const [, y, m, d, hh, mm, ss] = match;
        return { date: new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)), source: `mdls ${key}` };
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function readCaptureDatetime(filePath: string): Promise<{ captureDatetime: Date; timeSource: string }> {
  const exifDate = await readEmbeddedExifDate(filePath);
  if (exifDate) return { captureDatetime: exifDate, timeSource: "ARW EXIF DateTimeOriginal" };

  const mdlsDate = await readMdlsDate(filePath);
  if (mdlsDate) return { captureDatetime: mdlsDate.date, timeSource: mdlsDate.source };

  const stat = await fs.stat(filePath);
  return { captureDatetime: stat.mtime, timeSource: "filesystem modified time" };
}

function representativePhotos(photos: PhotoItem[]): PhotoItem[] {
  if (photos.length <= 8) return photos;
  const indexes = [0, 1, 2, Math.floor(photos.length / 2), photos.length - 3, photos.length - 2, photos.length - 1];
  const seen = new Set<number>();
  return indexes.filter(index => index >= 0 && index < photos.length && !seen.has(index) && seen.add(index)).map(index => photos[index]);
}

function previewTargetsForShoot(shoot: ShootItem): PhotoItem[] {
  const targets = [...representativePhotos(shoot.photos)];
  if (shoot.splitFromPrevious) targets.push(shoot.splitFromPrevious.previous, shoot.splitFromPrevious.current);
  const seen = new Set<string>();
  return targets.filter(photo => {
    if (seen.has(photo.path)) return false;
    seen.add(photo.path);
    return true;
  });
}

function detectShoots(photos: PhotoItem[], gapMinutes: number): ShootItem[] {
  if (photos.length === 0) return [];
  const thresholdMs = gapMinutes * 60 * 1000;
  const groups: PhotoItem[][] = [[photos[0]]];
  const splitMarkers: Array<{ previous: PhotoItem; current: PhotoItem } | undefined> = [undefined];

  for (const photo of photos.slice(1)) {
    const previous = groups[groups.length - 1][groups[groups.length - 1].length - 1];
    const dateChanged = photoDateKey(photo) !== photoDateKey(previous);
    const gapExceeded = new Date(photo.captureDatetime).getTime() - new Date(previous.captureDatetime).getTime() > thresholdMs;
    if (dateChanged || gapExceeded) {
      groups.push([]);
      splitMarkers.push({ previous, current: photo });
    }
    groups[groups.length - 1].push(photo);
  }

  return groups.map((group, index) => ({
    id: `shoot-${index + 1}-${group[0].path}`,
    index: index + 1,
    photos: group,
    folderName: defaultShootName(index + 1, new Date(group[0].captureDatetime)),
    include: true,
    splitFromPrevious: splitMarkers[index],
    previewPaths: {}
  }));
}

async function addMissingPreviews(shoots: ShootItem[], tempRoot: string, sendProgress: ProgressSender<ScanProgress>, startPercent = 78): Promise<void> {
  const previewRoot = path.join(tempRoot, new Date().toISOString().replace(/[:.]/g, "-"));
  const previewTargets = shoots.flatMap(shoot =>
    previewTargetsForShoot(shoot)
      .filter(photo => isArwPath(photo.path))
      .filter(photo => !shoot.previewPaths[photo.path])
      .map(photo => ({ shoot, photo }))
  );

  for (let index = 0; index < previewTargets.length; index += 1) {
    const { shoot, photo } = previewTargets[index];
    const thumbnail = await quicklookThumbnail(photo.path, path.join(previewRoot, `batch_${String(shoot.index).padStart(2, "0")}`));
    if (thumbnail) shoot.previewPaths[photo.path] = thumbnail;
    sendProgress({
      phase: "preview",
      processed: index + 1,
      total: previewTargets.length,
      currentFile: photo.name,
      percent: previewTargets.length === 0 ? 95 : startPercent + ((index + 1) / previewTargets.length) * (98 - startPercent)
    });
  }
}

async function quicklookThumbnail(rawPath: string, outputDir: string): Promise<string | null> {
  await fs.mkdir(outputDir, { recursive: true });
  let before = new Set<string>();
  try {
    before = new Set(await fs.readdir(outputDir));
  } catch {
    before = new Set();
  }
  try {
    await execFileAsync("qlmanage", ["-t", "-s", String(QUICK_LOOK_SIZE), "-o", outputDir, rawPath], { timeout: 15000 });
  } catch {
    return null;
  }

  const entries = await fs.readdir(outputDir);
  const created = entries.filter(entry => !before.has(entry)).map(entry => path.join(outputDir, entry));
  const candidates = created.length > 0 ? created : entries.map(entry => path.join(outputDir, entry));
  const images = [];
  for (const candidate of candidates) {
    const ext = path.extname(candidate).toLowerCase();
    if (ext !== ".png" && ext !== ".gif") continue;
    const stat = await fs.stat(candidate);
    images.push({ candidate, mtime: stat.mtimeMs });
  }
  images.sort((a, b) => b.mtime - a.mtime);
  return images[0]?.candidate ?? null;
}

export async function scanSource(source: string, gapMinutes: number, tempRoot: string, cacheDir: string, sendProgress: ProgressSender<ScanProgress>): Promise<ScanResult> {
  sendProgress({ phase: "finding", processed: 0, total: 0, percent: 2 });
  const paths = await findArwPaths(source);
  const cache = await loadMetadataCache(cacheDir, source);
  const photos: PhotoItem[] = [];
  const cachedPhotosForDisk: CachedPhotoItem[] = [];
  let metadataRead = 0;
  let metadataReused = 0;
  for (let index = 0; index < paths.length; index += 1) {
    const filePath = paths[index];
    const stat = await fs.stat(filePath);
    const cached = cache.photos[filePath];
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      photos.push(cached);
      cachedPhotosForDisk.push(cached);
      metadataReused += 1;
    } else {
      const { captureDatetime, timeSource } = await readCaptureDatetime(filePath);
      const photo = serializeCachedPhoto(filePath, captureDatetime, stat.size, stat.mtimeMs, timeSource);
      photos.push(photo);
      cachedPhotosForDisk.push(photo);
      metadataRead += 1;
    }
    sendProgress({
      phase: "metadata",
      processed: index + 1,
      total: paths.length,
      currentFile: metadataReused + metadataRead === index + 1 && cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs
        ? `Cached ${path.basename(filePath)}`
        : path.basename(filePath),
      percent: paths.length === 0 ? 0 : 5 + ((index + 1) / paths.length) * 70
    });
  }

  await saveMetadataCache(cacheDir, source, cachedPhotosForDisk);

  photos.sort((a, b) => new Date(a.captureDatetime).getTime() - new Date(b.captureDatetime).getTime() || a.path.localeCompare(b.path));
  const shoots = detectShoots(photos, gapMinutes);
  sendProgress({ phase: "batching", processed: photos.length, total: photos.length, percent: 78 });

  await addMissingPreviews(shoots, tempRoot, sendProgress);

  const reportPath = await writeScanReport(source, photos, shoots, gapMinutes);
  sendProgress({ phase: "report", processed: photos.length, total: photos.length, percent: 100 });
  return {
    photos,
    shoots,
    reportPath,
    metadataRead,
    metadataReused,
    message: `Found ${photos.length} .ARW files across ${shoots.length} date/time batch(es). Dates found: ${summarizeDates(photos)}. Metadata read: ${metadataRead}; reused from cache: ${metadataReused}.`
  };
}

export async function recalculateBatches(request: RecalculateRequest, tempRoot: string, sendProgress: ProgressSender<ScanProgress>): Promise<RecalculateResult> {
  sendProgress({ phase: "recalculating", processed: request.photos.length, total: request.photos.length, percent: 35 });
  const photos = [...request.photos].sort((a, b) => new Date(a.captureDatetime).getTime() - new Date(b.captureDatetime).getTime() || a.path.localeCompare(b.path));
  const shoots = detectShoots(photos, request.gapMinutes);
  for (const shoot of shoots) {
    for (const photo of shoot.photos) {
      const previewPath = request.previewPaths[photo.path];
      if (previewPath) shoot.previewPaths[photo.path] = previewPath;
    }
  }
  sendProgress({ phase: "batching", processed: photos.length, total: photos.length, percent: 85 });
  await addMissingPreviews(shoots, tempRoot, sendProgress, 86);
  const reportPath = await writeScanReport(request.source, photos, shoots, request.gapMinutes);
  sendProgress({ phase: "report", processed: photos.length, total: photos.length, percent: 100 });
  return {
    shoots,
    reportPath,
    message: `Recalculated ${shoots.length} batch(es) from cached metadata. No metadata was reread.`
  };
}

export async function ensurePreviews(request: EnsurePreviewsRequest, tempRoot: string, sendProgress: ProgressSender<ScanProgress>): Promise<EnsurePreviewsResult> {
  const shoots = request.shoots.map(shoot => ({
    ...shoot,
    photos: [...shoot.photos],
    previewPaths: { ...shoot.previewPaths }
  }));
  sendProgress({ phase: "preview", processed: 0, total: shoots.length, percent: 5 });
  await addMissingPreviews(shoots, tempRoot, sendProgress, 12);
  sendProgress({ phase: "preview", processed: shoots.length, total: shoots.length, percent: 100 });
  return { shoots };
}

async function writeScanReport(source: string, photos: PhotoItem[], shoots: ShootItem[], gapMinutes: number): Promise<string> {
  const reportPath = path.join(process.cwd(), "Last_Scan_Report.txt");
  const lines = [
    `${APP_NAME} Last Scan Report`,
    `Scan time: ${new Date().toISOString()}`,
    `Source: ${source}`,
    `Gap threshold: ${gapMinutes} minutes`,
    `Total ARW files: ${photos.length}`,
    `Dates found: ${photos.length ? summarizeDates(photos) : "none"}`,
    `Batches found: ${shoots.length}`,
    "",
    "Batches:"
  ];
  for (const shoot of shoots) {
    lines.push(`Batch ${shoot.index}: ${shoot.photos[0].captureDatetime} to ${shoot.photos[shoot.photos.length - 1].captureDatetime} | ${shoot.photos.length} files | ${shoot.folderName}`);
  }
  lines.push("", "Files:", "capture_datetime\ttime_source\tsize_bytes\tpath");
  for (const photo of photos) lines.push(`${photo.captureDatetime}\t${photo.timeSource}\t${photo.size}\t${photo.path}`);
  await fs.writeFile(reportPath, `${lines.join("\n")}\n`, "utf-8");
  return reportPath;
}

async function reserveDestination(destination: string, photoSize: number, reserved: Set<string>): Promise<{ action: "skip" | "copy"; finalDestination: string }> {
  if (await pathExists(destination)) {
    const stat = await fs.stat(destination);
    if (stat.size === photoSize) return { action: "skip", finalDestination: destination };
  }
  if (!(await pathExists(destination)) && !reserved.has(destination)) {
    reserved.add(destination);
    return { action: "copy", finalDestination: destination };
  }

  const parsed = path.parse(destination);
  for (let counter = 1; counter < 10000; counter += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}_${String(counter).padStart(3, "0")}${parsed.ext}`);
    if (!(await pathExists(candidate)) && !reserved.has(candidate)) {
      reserved.add(candidate);
      return { action: "copy", finalDestination: candidate };
    }
  }
  throw new Error(`Could not create a unique filename for ${destination}`);
}

async function copyWithMetadata(source: string, destination: string, onProgress?: (bytesCopied: number) => void): Promise<number> {
  const sourceStat = await fs.stat(source);
  let copied = 0;
  const reader = createReadStream(source);
  reader.on("data", chunk => {
    copied += chunk.length;
    onProgress?.(Math.min(copied, sourceStat.size));
  });
  await pipeline(reader, createWriteStream(destination));
  await fs.chmod(destination, sourceStat.mode);
  await fs.utimes(destination, sourceStat.atime, sourceStat.mtime);
  const destStat = await fs.stat(destination);
  if (destStat.size !== sourceStat.size) {
    throw new Error(`size mismatch (${sourceStat.size} source bytes, ${destStat.size} copied bytes)`);
  }
  return destStat.size;
}

async function runPool<T, R>(items: T[], workerCount: number, worker: (item: T, index: number) => Promise<R>, onDone: (result: R) => void, shouldStop?: () => boolean): Promise<void> {
  let cursor = 0;
  async function next(): Promise<void> {
    if (shouldStop?.()) return;
    const current = cursor;
    cursor += 1;
    if (current >= items.length) return;
    const result = await worker(items[current], current);
    onDone(result);
    await next();
  }
  await Promise.all(Array.from({ length: Math.min(workerCount, items.length) }, next));
}

export async function startCopy(request: CopyRequest, sendProgress: ProgressSender<CopyProgress>): Promise<CopyResult> {
  copyCancelRequested = false;
  if (!Array.isArray(request.destinations) || request.destinations.length === 0) {
    throw new Error("Choose at least one destination before copying.");
  }
  if (!Array.isArray(request.shoots) || request.shoots.length === 0) {
    throw new Error("Select at least one batch before copying.");
  }
  for (const destination of request.destinations) {
    assertDestinationIsNotSource(request.source, destination.path);
    const stat = await fs.stat(destination.path);
    if (!stat.isDirectory()) {
      throw new Error(`Destination folder does not exist: ${destination.label}: ${destination.path}`);
    }
  }

  const total = request.shoots.reduce((sum, shoot) => sum + (shoot.include ? shoot.photos.length : 0), 0) * request.destinations.length;
  const totalProgressBytes = request.shoots.reduce((sum, shoot) => sum + (shoot.include ? shoot.photos.reduce((photoSum, photo) => photoSum + photo.size, 0) : 0), 0) * request.destinations.length;
  let completedTotal = 0;
  let allErrors = 0;
  let copiedBytesTotal = 0;
  let progressBytesCompleted = 0;
  const startedAt = Date.now();
  const shootCompleted = new Map<string, number>();
  const shootProgressBytes = new Map<string, number>();

  for (const destination of request.destinations) {
    for (const shoot of request.shoots) {
      if (copyCancelRequested) break;
      if (!shoot.include || shoot.photos.length === 0) continue;
      const result = await copyShoot(
        destination,
        shoot,
        request.subfolders,
        request.renameCopies,
        total,
        totalProgressBytes,
        completedTotal,
        shootCompleted.get(shoot.id) ?? 0,
        shoot.photos.length * request.destinations.length,
        progressBytesCompleted,
        shootProgressBytes.get(shoot.id) ?? 0,
        shoot.photos.reduce((sum, photo) => sum + photo.size, 0) * request.destinations.length,
        copiedBytesTotal,
        startedAt,
        sendProgress
      );
      completedTotal += result.completed;
      shootCompleted.set(shoot.id, (shootCompleted.get(shoot.id) ?? 0) + result.completed);
      progressBytesCompleted += result.progressBytes;
      shootProgressBytes.set(shoot.id, (shootProgressBytes.get(shoot.id) ?? 0) + result.progressBytes);
      copiedBytesTotal += result.bytesWritten;
      allErrors += result.errors;
    }
    if (copyCancelRequested) break;
  }

  if (copyCancelRequested) {
    return {
      errors: allErrors,
      message: allErrors > 0
        ? `Copy canceled safely. In-progress files finished verification first. The source/SD card was not modified. ${allErrors} file error(s) occurred.`
        : "Copy canceled safely. In-progress files finished verification first. The source/SD card was not modified."
    };
  }

  return {
    errors: allErrors,
    message: allErrors > 0 ? `Copy complete. The source/SD card was not modified. ${allErrors} file error(s) occurred.` : "Copy complete. The source/SD card was not modified."
  };
}

async function copyShoot(
  destination: CopyDestination,
  shoot: ShootItem,
  subfolders: string[],
  renameCopies: boolean,
  total: number,
  totalProgressBytes: number,
  completedBeforeShoot: number,
  completedBeforeThisShoot: number,
  shootTotal: number,
  progressBytesBeforeShoot: number,
  progressBytesBeforeThisShoot: number,
  shootProgressBytesTotal: number,
  bytesBeforeShoot: number,
  startedAt: number,
  sendProgress: ProgressSender<CopyProgress>
): Promise<{ completed: number; errors: number; bytesWritten: number; progressBytes: number }> {
  const safeShootName = safeFolderName(shoot.folderName);
  const safeSubfolders = subfolders.map(safeFolderName).filter(Boolean);
  const firstSubfolder = safeSubfolders[0] || "RAW";
  const shootFolder = safeJoin(destination.path, safeShootName);
  const rawFolder = safeJoin(shootFolder, firstSubfolder);
  await fs.mkdir(rawFolder, { recursive: true });
  await assertRealPathInside(destination.path, shootFolder);
  await assertRealPathInside(destination.path, rawFolder);
  for (const subfolder of safeSubfolders) {
    const subfolderPath = safeJoin(shootFolder, subfolder);
    await fs.mkdir(subfolderPath, { recursive: true });
    await assertRealPathInside(destination.path, subfolderPath);
  }

  const reserved = new Set<string>();
  let completed = 0;
  let errors = 0;
  let bytesWritten = 0;
  let progressBytesDone = 0;
  const activeProgressBytes = new Map<number, number>();
  let activeFiles = 0;
  let latestFile = "";
  let latestSpeed = 0;
  let lastProgressSentAt = 0;

  const sendCopyProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressSentAt < 500) return;
    lastProgressSentAt = now;
    const inFlightBytes = [...activeProgressBytes.values()].reduce((sum, value) => sum + value, 0);
    const elapsedSeconds = Math.max(0.001, (now - startedAt) / 1000);
    sendProgress({
      completed: completedBeforeShoot + completed,
      total,
      percent: totalProgressBytes === 0 ? 0 : ((progressBytesBeforeShoot + progressBytesDone + inFlightBytes) / totalProgressBytes) * 100,
      bytesCompleted: progressBytesBeforeShoot + progressBytesDone + inFlightBytes,
      bytesTotal: totalProgressBytes,
      shootId: shoot.id,
      shootIndex: shoot.index,
      shootFolderName: shoot.folderName,
      shootCompleted: completedBeforeThisShoot + completed,
      shootTotal,
      shootBytesCompleted: progressBytesBeforeThisShoot + progressBytesDone + inFlightBytes,
      shootBytesTotal: shootProgressBytesTotal,
      activeFiles,
      currentFile: latestFile,
      destinationLabel: destination.label,
      elapsed: formatDuration(elapsedSeconds),
      currentSpeed: formatSpeed(latestSpeed),
      averageSpeed: formatSpeed((bytesBeforeShoot + bytesWritten) / elapsedSeconds)
    });
  };

  await runPool(
    shoot.photos,
    PARALLEL_COPY_WORKERS,
    async (photo, index) => {
      const offset = index + 1;
      if (!isArwPath(photo.path)) {
        return { offset, bytesWritten: 0, errors: 1, currentSpeed: 0, photoName: path.basename(photo.path) || photo.name };
      }
      const destinationName = renameCopies ? renamedCopyName(safeShootName, offset, photo.path) : safeFileName(photo.name, `Photo_${String(offset).padStart(4, "0")}.ARW`);
      const intendedDestination = safeJoin(rawFolder, destinationName);
      try {
        latestFile = photo.name;
        activeFiles += 1;
        activeProgressBytes.set(index, 0);
        sendCopyProgress(true);
        const { action, finalDestination } = await reserveDestination(intendedDestination, photo.size, reserved);
        if (action === "skip") {
          activeFiles -= 1;
          activeProgressBytes.delete(index);
          return { offset, bytesWritten: 0, errors: 0, currentSpeed: 0, photoName: photo.name };
        }
        const fileStartedAt = Date.now();
        const copiedSize = await copyWithMetadata(photo.path, finalDestination, copiedBytes => {
          activeProgressBytes.set(index, Math.min(copiedBytes, photo.size));
          sendCopyProgress();
        });
        activeFiles -= 1;
        activeProgressBytes.delete(index);
        const seconds = Math.max(0.001, (Date.now() - fileStartedAt) / 1000);
        const currentSpeed = copiedSize / seconds;
        return { offset, bytesWritten: copiedSize, errors: 0, currentSpeed, photoName: photo.name };
      } catch (error) {
        activeFiles = Math.max(0, activeFiles - 1);
        activeProgressBytes.delete(index);
        return { offset, bytesWritten: 0, errors: 1, currentSpeed: 0, photoName: photo.name };
      }
    },
    result => {
      completed += 1;
      errors += result.errors;
      bytesWritten += result.bytesWritten;
      progressBytesDone += shoot.photos[result.offset - 1]?.size ?? 0;
      latestFile = result.photoName;
      latestSpeed = result.currentSpeed;
      sendCopyProgress(true);
    },
    () => copyCancelRequested
  );

  return { completed, errors, bytesWritten, progressBytes: progressBytesDone };
}
