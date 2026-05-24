import { useEffect, useMemo, useRef, useState } from "react";
import {
  CopyDestination,
  CopyProgress,
  DEFAULT_GAP_MINUTES,
  DEFAULT_PRESET,
  PhotoItem,
  ScanProgress,
  ShootItem
} from "../common/types.js";

const SAVED_DESTINATIONS_KEY = "abrar-photo-importer.custom-destinations.v2";

interface CustomDestination {
  id: string;
  label: string;
  path: string;
  enabled: boolean;
}

type WorkflowStep = 1 | 2 | 3;

interface BatchCopyStatus {
  completed: number;
  total: number;
  bytesCompleted: number;
  bytesTotal: number;
  activeFiles: number;
  currentFile: string;
  destinationLabel: string;
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

function formatRange(shoot: ShootItem): string {
  const start = new Date(shoot.photos[0].captureDatetime);
  const end = new Date(shoot.photos[shoot.photos.length - 1].captureDatetime);
  return `${start.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} ${start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} to ${end.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function photoTime(photo: PhotoItem): string {
  return new Date(photo.captureDatetime).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  });
}

function fileUrl(filePath: string): string {
  return `file://${encodeURI(filePath)}`;
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

function defaultShootName(index: number, photo: PhotoItem): string {
  return `${photo.captureDatetime.slice(0, 10)}_Shoot_${String(index).padStart(2, "0")}`;
}

function totalSize(photos: PhotoItem[]): number {
  return photos.reduce((sum, photo) => sum + photo.size, 0);
}

function representativePhotos(photos: PhotoItem[]): PhotoItem[] {
  if (photos.length <= 8) return photos;
  const indexes = [0, 1, 2, Math.floor(photos.length / 2), photos.length - 3, photos.length - 2, photos.length - 1];
  const seen = new Set<number>();
  return indexes.filter(index => index >= 0 && index < photos.length && !seen.has(index) && seen.add(index)).map(index => photos[index]);
}

function timeSourceSummary(photos: PhotoItem[]): string {
  const counts = new Map<string, number>();
  for (const photo of photos) counts.set(photo.timeSource, (counts.get(photo.timeSource) ?? 0) + 1);
  return [...counts.entries()].map(([source, count]) => `${source} (${count})`).join(", ");
}

function parsePreset(value: string): string[] {
  const folders = value.split(",").map(safeFolderName).filter(Boolean);
  return folders.length > 0 ? folders : ["RAW"];
}

function flattenPreviewPaths(shoots: ShootItem[]): Record<string, string> {
  const previews: Record<string, string> = {};
  for (const shoot of shoots) {
    for (const [photoPath, previewPath] of Object.entries(shoot.previewPaths)) {
      previews[photoPath] = previewPath;
    }
  }
  return previews;
}

function reindexShoots(shoots: ShootItem[]): ShootItem[] {
  return shoots.map((shoot, index) => ({
    ...shoot,
    index: index + 1,
    folderName: shoot.folderName || defaultShootName(index + 1, shoot.photos[0])
  }));
}

function labelForDestination(folderPath: string, fallback: string): string {
  return folderPath.toLowerCase().includes("dropbox") ? "Dropbox" : fallback;
}

function loadSavedDestinations(): CustomDestination[] {
  try {
    const raw = window.localStorage.getItem(SAVED_DESTINATIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CustomDestination[];
    return parsed.filter(item => item.path).map(item => ({ ...item, enabled: item.enabled ?? true }));
  } catch {
    return [];
  }
}

export default function App() {
  const [source, setSource] = useState("");
  const [copyHardDrive, setCopyHardDrive] = useState(true);
  const [hardDriveDest, setHardDriveDest] = useState("");
  const [customDestinations, setCustomDestinations] = useState<CustomDestination[]>(() => loadSavedDestinations());
  const [gapMinutes, setGapMinutes] = useState(DEFAULT_GAP_MINUTES);
  const [gapNeedsRefresh, setGapNeedsRefresh] = useState(false);
  const [preset, setPreset] = useState(DEFAULT_PRESET);
  const [renameCopies, setRenameCopies] = useState(false);
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [shoots, setShoots] = useState<ShootItem[]>([]);
  const [status, setStatus] = useState("Choose a source folder or SD card, then scan.");
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [copyProgress, setCopyProgress] = useState<CopyProgress | null>(null);
  const [batchCopyProgress, setBatchCopyProgress] = useState<Record<string, BatchCopyStatus>>({});
  const [busy, setBusy] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const [currentStep, setCurrentStep] = useState<WorkflowStep>(1);
  const [error, setError] = useState("");
  const [lastScannedSource, setLastScannedSource] = useState("");
  const [collapsedShootIds, setCollapsedShootIds] = useState<Set<string>>(new Set());
  const [batchGapDrafts, setBatchGapDrafts] = useState<Record<string, number>>({});
  const recalcRunId = useRef(0);

  useEffect(() => {
    void window.abrarImporter.getInitialPaths().then(paths => {
      setSource(paths.source);
    });
    const offScan = window.abrarImporter.onScanProgress(setScanProgress);
    const offCopy = window.abrarImporter.onCopyProgress(progress => {
      setCopyProgress(progress);
      setBatchCopyProgress(current => ({
        ...current,
        [progress.shootId]: {
          completed: progress.shootCompleted,
          total: progress.shootTotal,
          bytesCompleted: progress.shootBytesCompleted,
          bytesTotal: progress.shootBytesTotal,
          activeFiles: progress.activeFiles,
          currentFile: progress.currentFile,
          destinationLabel: progress.destinationLabel
        }
      }));
    });
    return () => {
      offScan();
      offCopy();
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem(SAVED_DESTINATIONS_KEY, JSON.stringify(customDestinations));
  }, [customDestinations]);

  const selectedCount = useMemo(() => shoots.filter(shoot => shoot.include).reduce((sum, shoot) => sum + shoot.photos.length, 0), [shoots]);
  const selectedSize = useMemo(() => shoots.filter(shoot => shoot.include).reduce((sum, shoot) => sum + totalSize(shoot.photos), 0), [shoots]);
  const selectedDestinationCount = useMemo(() => {
    const customCount = customDestinations.filter(destination => destination.enabled).length;
    return (copyHardDrive ? 1 : 0) + customCount;
  }, [copyHardDrive, customDestinations]);

  async function choosePath(setter: (value: string) => void): Promise<void> {
    const selected = await window.abrarImporter.chooseDirectory();
    if (selected) setter(selected);
  }

  async function scan(): Promise<void> {
    setError("");
    if (!source.trim()) {
      setError("Choose a source folder or SD card first.");
      return;
    }
    if (gapMinutes <= 0) {
      setError("Gap threshold must be greater than zero.");
      return;
    }
    setBusy(true);
    setStatus("Scanning source...");
    setCopyProgress(null);
    setBatchCopyProgress({});
    try {
      const result = await window.abrarImporter.scanSource(source, gapMinutes);
      setPhotos(result.photos);
      setShoots(result.shoots);
      setLastScannedSource(source);
      setGapNeedsRefresh(false);
      if (result.photos.length > 0) setCurrentStep(2);
      setStatus(result.photos.length === 0 ? "No .ARW files were found in the selected source." : result.message);
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : String(scanError));
      setStatus("Scan failed. No files were copied or modified.");
    } finally {
      setBusy(false);
    }
  }

  async function recalculateFromCachedMetadata(nextGapMinutes: number): Promise<void> {
    if (photos.length === 0 || source !== lastScannedSource || nextGapMinutes <= 0) return;
    const runId = recalcRunId.current + 1;
    recalcRunId.current = runId;
    setError("");
    setScanProgress(null);
    setStatus("Recalculating batches from cached metadata...");
    try {
      const result = await window.abrarImporter.recalculateBatches({
        source,
        photos,
        gapMinutes: nextGapMinutes,
        previewPaths: flattenPreviewPaths(shoots)
      });
      if (recalcRunId.current !== runId) return;
      setShoots(result.shoots);
      setGapNeedsRefresh(false);
      setCurrentStep(2);
      setStatus(result.message);
      setScanProgress(null);
    } catch (recalcError) {
      if (recalcRunId.current !== runId) return;
      setError(recalcError instanceof Error ? recalcError.message : String(recalcError));
      setStatus("Could not recalculate batches from cached metadata.");
    } finally {
      if (recalcRunId.current === runId) setScanProgress(null);
    }
  }

  async function addCustomDestination(): Promise<void> {
    const selected = await window.abrarImporter.chooseDirectory();
    if (!selected) return;
    setCustomDestinations(current => [
      ...current,
      {
        id: `destination-${Date.now()}`,
        label: labelForDestination(selected, `Destination ${current.length + 1}`),
        path: selected,
        enabled: true
      }
    ]);
  }

  function updateCustomDestination(id: string, updates: Partial<CustomDestination>): void {
    setCustomDestinations(current => current.map(item => (item.id === id ? { ...item, ...updates } : item)));
  }

  async function chooseCustomDestination(id: string): Promise<void> {
    const selected = await window.abrarImporter.chooseDirectory();
    if (!selected) return;
    updateCustomDestination(id, { path: selected, label: labelForDestination(selected, "Destination") });
  }

  function updateShoot(id: string, updater: (shoot: ShootItem) => ShootItem): void {
    setShoots(current => current.map(shoot => (shoot.id === id ? updater(shoot) : shoot)));
  }

  async function refreshPreviewsForShoots(targetShoots: ShootItem[]): Promise<void> {
    if (targetShoots.length === 0) return;
    setBusy(true);
    setError("");
    setScanProgress({ phase: "preview", processed: 0, total: targetShoots.length, percent: 5 });
    setStatus("Building missing previews for the updated batch...");
    try {
      const result = await window.abrarImporter.ensurePreviews({ shoots: targetShoots });
      setShoots(current => current.map(shoot => {
        const updated = result.shoots.find(item => item.id === shoot.id);
        return updated ? { ...shoot, previewPaths: { ...shoot.previewPaths, ...updated.previewPaths } } : shoot;
      }));
      setStatus("Previews refreshed for the updated batch.");
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : String(previewError));
      setStatus("Could not refresh some previews. Copying is still safe.");
    } finally {
      setBusy(false);
      setScanProgress(null);
    }
  }

  function splitShoot(shoot: ShootItem, photo: PhotoItem): void {
    const splitIndex = shoot.photos.findIndex(item => item.path === photo.path);
    if (splitIndex <= 0) return;
    const firstPhotos = shoot.photos.slice(0, splitIndex);
    const secondPhotos = shoot.photos.slice(splitIndex);
    const firstPaths = new Set(firstPhotos.map(item => item.path));
    const secondPaths = new Set(secondPhotos.map(item => item.path));
    const firstShoot: ShootItem = {
      ...shoot,
      photos: firstPhotos,
      previewPaths: Object.fromEntries(Object.entries(shoot.previewPaths).filter(([photoPath]) => firstPaths.has(photoPath)))
    };
    const secondShoot: ShootItem = {
      ...shoot,
      id: `${shoot.id}-split-${Date.now()}`,
      photos: secondPhotos,
      folderName: defaultShootName(shoot.index + 1, secondPhotos[0]),
      include: shoot.include,
      splitFromPrevious: { previous: firstPhotos[firstPhotos.length - 1], current: secondPhotos[0] },
      previewPaths: Object.fromEntries(Object.entries(shoot.previewPaths).filter(([photoPath]) => secondPaths.has(photoPath)))
    };
    setShoots(current => {
      const position = current.findIndex(item => item.id === shoot.id);
      return reindexShoots([...current.slice(0, position), firstShoot, secondShoot, ...current.slice(position + 1)]);
    });
    setStatus(`Split batch at ${photo.name}. Review both batches before copying.`);
    void refreshPreviewsForShoots([firstShoot, secondShoot]);
  }

  function mergeWithPrevious(shoot: ShootItem): void {
    setShoots(current => {
      const position = current.findIndex(item => item.id === shoot.id);
      if (position <= 0) return current;
      const previous = current[position - 1];
      const merged: ShootItem = {
        ...previous,
        photos: [...previous.photos, ...shoot.photos],
        previewPaths: { ...previous.previewPaths, ...shoot.previewPaths }
      };
      return reindexShoots([...current.slice(0, position - 1), merged, ...current.slice(position + 1)]);
    });
    setStatus(`Merged batch ${shoot.index} with the previous batch.`);
  }

  function reset(): void {
    setPhotos([]);
    setShoots([]);
    setScanProgress(null);
    setCopyProgress(null);
    setBatchCopyProgress({});
    setIsCopying(false);
    setError("");
    setLastScannedSource("");
    setGapNeedsRefresh(false);
    setCollapsedShootIds(new Set());
    setBatchGapDrafts({});
    setCurrentStep(1);
    setStatus("Reset complete. Choose a source folder or SD card, then scan.");
  }

  async function startCopy(): Promise<void> {
    setError("");
    const selectedShoots = shoots.filter(shoot => shoot.include).map(shoot => ({
      ...shoot,
      folderName: safeFolderName(shoot.folderName)
    }));
    if (selectedShoots.length === 0) {
      setError("Select at least one batch before copying.");
      return;
    }

    const destinations: CopyDestination[] = [];
    if (copyHardDrive) destinations.push({ label: "Hard Drive", path: hardDriveDest });
    for (const destination of customDestinations) {
      if (destination.enabled) {
        destinations.push({ label: destination.label, path: destination.path });
      }
    }
    if (destinations.length === 0) {
      setError("Choose at least one destination before copying.");
      return;
    }
    if (destinations.some(destination => !destination.path.trim())) {
      setError("Choose destination folders before copying.");
      return;
    }
    if (!window.confirm("Start copying selected shoots? Files on the SD card/source will only be read, never deleted, moved, or modified.")) return;

    setBusy(true);
    setIsCopying(true);
    setBatchCopyProgress(Object.fromEntries(selectedShoots.map(shoot => [
      shoot.id,
      {
        completed: 0,
        total: shoot.photos.length * destinations.length,
        bytesCompleted: 0,
        bytesTotal: totalSize(shoot.photos) * destinations.length,
        activeFiles: 0,
        currentFile: "",
        destinationLabel: ""
      }
    ])));
    setStatus("Copying selected shoots...");
    try {
      const result = await window.abrarImporter.startCopy({
        source,
        shoots: selectedShoots,
        destinations,
        subfolders: parsePreset(preset),
        renameCopies
      });
      setStatus(result.message);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : String(copyError));
      setStatus("Copy failed. The source/SD card was not modified.");
    } finally {
      setBusy(false);
      setIsCopying(false);
    }
  }

  async function cancelCopy(): Promise<void> {
    await window.abrarImporter.cancelCopy();
    setStatus("Cancel requested. Finishing active file copies safely before stopping...");
  }

  function setGapThreshold(value: number): void {
    const nextValue = Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1;
    setGapMinutes(nextValue);
    if (photos.length > 0 && source === lastScannedSource) setGapNeedsRefresh(true);
  }

  async function recalculateSingleBatch(shoot: ShootItem, nextGapMinutes: number): Promise<void> {
    if (nextGapMinutes <= 0 || shoot.photos.length === 0) {
      setError("Batch gap must be greater than zero.");
      return;
    }
    const runId = recalcRunId.current + 1;
    recalcRunId.current = runId;
    setBusy(true);
    setError("");
    setScanProgress(null);
    setStatus(`Recalculating batch ${shoot.index} from cached metadata...`);
    try {
      const result = await window.abrarImporter.recalculateBatches({
        source,
        photos: shoot.photos,
        gapMinutes: nextGapMinutes,
        previewPaths: shoot.previewPaths
      });
      if (recalcRunId.current !== runId) return;
      setShoots(current => {
        const position = current.findIndex(item => item.id === shoot.id);
        if (position < 0) return current;
        const replacementShoots = result.shoots.map((item, offset) => ({
          ...item,
          id: `${shoot.id}-batch-gap-${Date.now()}-${offset}`,
          include: shoot.include,
          folderName: offset === 0 ? shoot.folderName : defaultShootName(position + offset + 1, item.photos[0])
        }));
        return reindexShoots([...current.slice(0, position), ...replacementShoots, ...current.slice(position + 1)]);
      });
      setCollapsedShootIds(new Set());
      setBatchGapDrafts({});
      setStatus(`Batch ${shoot.index} recalculated into ${result.shoots.length} batch(es). Review previews before copying.`);
      setScanProgress(null);
    } catch (recalcError) {
      if (recalcRunId.current !== runId) return;
      setError(recalcError instanceof Error ? recalcError.message : String(recalcError));
      setStatus("Could not recalculate that batch from cached metadata.");
    } finally {
      if (recalcRunId.current === runId) {
        setBusy(false);
        setScanProgress(null);
      }
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>aDrop</h1>
          <a className="creator-link" href="https://instagram.com/AbrarAltaay" target="_blank" rel="noreferrer">
            Created by Abrar Altaay
          </a>
        </div>
        <div className="topbar-right">
          <div className="topbar-summary">
            <span>{photos.length} RAW files</span>
            <span>{shoots.length} batches</span>
            <span>{formatBytes(selectedSize)} selected</span>
          </div>
          <button className="ghost-button reset-button" disabled={busy} onClick={reset}>Reset</button>
        </div>
      </header>

      <nav className="step-nav" aria-label="Import steps">
        {[1, 2, 3].map(step => (
          <button
            key={step}
            className={currentStep === step ? "active" : ""}
            disabled={busy || (step > 1 && shoots.length === 0)}
            onClick={() => setCurrentStep(step as WorkflowStep)}
          >
            <span>{step}</span>
            {step === 1 ? "Scan setup" : step === 2 ? "Review shoots" : "Copy setup"}
          </button>
        ))}
      </nav>

      <main className="step-layout">
        {currentStep === 1 && (
          <section className="setup-panel step-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Step 1</p>
                <h2>Choose source and scan settings</h2>
              </div>
            </div>

            {error && <div className="notice error">{error}</div>}
            <ProgressArea scanProgress={scanProgress} copyProgress={copyProgress} status={status} />

            <label className="field field-wide">
              <span>Source / SD Card</span>
              <div className="path-control">
                <input value={source} onChange={event => setSource(event.target.value)} placeholder="/Volumes/Card/DCIM" />
                <button disabled={busy} onClick={() => void choosePath(setSource)}>Choose</button>
              </div>
            </label>

            <section className="gap-card">
              <div>
                <p className="eyebrow">Batch detection</p>
                <h3>New shoot gap</h3>
                <p className="help-text">
                  Batch detection groups photos into separate shoots by time. If the gap between two photos is longer than this number, the app starts a new batch.
                </p>
              </div>
              <div className="gap-control">
                <input
                  type="number"
                  min={1}
                  disabled={busy}
                  value={gapMinutes}
                  onChange={event => setGapThreshold(Number(event.target.value))}
                />
                <span>minutes</span>
                <div className="gap-stepper" aria-label="Adjust new shoot gap">
                  <button type="button" disabled={busy} aria-label="Increase new shoot gap" onClick={() => setGapThreshold(gapMinutes + 1)}>▲</button>
                  <button type="button" disabled={busy} aria-label="Decrease new shoot gap" onClick={() => setGapThreshold(gapMinutes - 1)}>▼</button>
                </div>
                {gapNeedsRefresh && (
                  <button className="refresh-icon-button" type="button" disabled={busy} aria-label="Refresh batches with new shoot gap" title="Refresh batches" onClick={() => void recalculateFromCachedMetadata(gapMinutes)}>
                    ↻
                  </button>
                )}
              </div>
            </section>

            <div className="step-actions">
              <button className="secondary-button" disabled>Back</button>
              <button className="primary-button" disabled={busy} onClick={() => void scan()}>Scan Source</button>
            </div>
          </section>
        )}

        {currentStep === 2 && (
          <section className="review-panel step-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Step 2</p>
                <h2>Preview and organize shoots</h2>
              </div>
              <div className="selection-pill">{selectedCount} photos selected</div>
            </div>

            {error && <div className="notice error">{error}</div>}
            <ProgressArea scanProgress={scanProgress} copyProgress={copyProgress} status={status} />

            {shoots.length === 0 ? (
              <div className="empty-state">
                <h3>No scan results yet</h3>
                <p>Select a source folder or SD card, then scan. If Quick Look cannot build previews, the app will still let you copy safely.</p>
              </div>
            ) : (
              <div className="shoot-grid">
                {shoots.map((shoot, index) => (
                  <ShootCard
                    key={shoot.id}
                    shoot={shoot}
                    canMerge={index > 0}
                    collapsed={collapsedShootIds.has(shoot.id)}
                    busy={busy}
                    batchGapMinutes={batchGapDrafts[shoot.id] ?? gapMinutes}
                    onToggle={() => updateShoot(shoot.id, current => ({ ...current, include: !current.include }))}
                    onRename={folderName => updateShoot(shoot.id, current => ({ ...current, folderName }))}
                    onSplit={photo => splitShoot(shoot, photo)}
                    onMerge={() => mergeWithPrevious(shoot)}
                    onBatchGapChange={value => setBatchGapDrafts(current => ({ ...current, [shoot.id]: value }))}
                    onRecalculateBatch={() => void recalculateSingleBatch(shoot, batchGapDrafts[shoot.id] ?? gapMinutes)}
                    onToggleCollapse={() => {
                      setCollapsedShootIds(current => {
                        const next = new Set(current);
                        if (next.has(shoot.id)) next.delete(shoot.id);
                        else next.add(shoot.id);
                        return next;
                      });
                    }}
                  />
                ))}
              </div>
            )}

            <div className="step-actions">
              <button className="secondary-button" disabled={busy} onClick={() => setCurrentStep(1)}>Back</button>
              <button className="primary-button" disabled={busy || shoots.length === 0} onClick={() => setCurrentStep(3)}>Next</button>
            </div>
          </section>
        )}

        {currentStep === 3 && (
          <section className="setup-panel step-panel copy-step-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Step 3</p>
                <h2>Choose destination and copy</h2>
              </div>
              <div className="selection-pill">{selectedCount} photos selected</div>
            </div>

            {error && <div className="notice error">{error}</div>}
            <ProgressArea scanProgress={scanProgress} copyProgress={copyProgress} status={status} />

            <div className="copy-step-grid">
              <CopyReviewPanel
                shoots={shoots}
                progressByShoot={batchCopyProgress}
                destinationCount={selectedDestinationCount}
                copying={isCopying || Boolean(copyProgress)}
                disabled={busy}
                onToggle={shootId => updateShoot(shootId, current => ({ ...current, include: !current.include }))}
                onRename={(shootId, folderName) => updateShoot(shootId, current => ({ ...current, folderName }))}
              />

              <div className="copy-controls">
                <div className="source-callout">
                  <span>Source</span>
                  <strong>{source || "No source selected"}</strong>
                </div>

                <div className="destination-section">
                  <label className="destination-card">
                    <div className="check-row">
                      <input type="checkbox" checked={copyHardDrive} onChange={event => setCopyHardDrive(event.target.checked)} />
                      <strong>Hard Drive</strong>
                    </div>
                    <div className="path-control">
                      <input value={hardDriveDest} onChange={event => setHardDriveDest(event.target.value)} placeholder="Choose a folder" />
                      <button disabled={busy} onClick={() => void choosePath(setHardDriveDest)}>Choose</button>
                    </div>
                  </label>

                  {customDestinations.map(destination => (
                    <label className="destination-card" key={destination.id}>
                      <div className="check-row">
                        <input type="checkbox" checked={destination.enabled} onChange={event => updateCustomDestination(destination.id, { enabled: event.target.checked })} />
                        <strong>{destination.label}</strong>
                      </div>
                      <div className="path-control">
                        <input value={destination.path} onChange={event => updateCustomDestination(destination.id, { path: event.target.value, label: labelForDestination(event.target.value, destination.label) })} placeholder="Choose a folder" />
                        <button disabled={busy} onClick={() => void chooseCustomDestination(destination.id)}>Choose</button>
                      </div>
                    </label>
                  ))}

                  <button className="add-destination-button" disabled={busy} onClick={() => void addCustomDestination()}>
                    <span>+</span> Add destination
                  </button>
                </div>

                <div className="copy-settings-card">
                  <label className="field">
                    <span>Subfolder preset</span>
                    <input value={preset} onChange={event => setPreset(event.target.value)} placeholder="RAW, EDITED" />
                    <small>First folder receives copied RAW files. Folders after each comma are created empty.</small>
                  </label>

                  <label className="toggle-row">
                    <input type="checkbox" checked={renameCopies} onChange={event => setRenameCopies(event.target.checked)} />
                    <span>Rename copied RAW files using batch folder name</span>
                  </label>
                </div>

                <div className="copy-action-card">
                  <div className="step-actions copy-actions">
                    <button className="secondary-button" disabled={busy} onClick={() => setCurrentStep(2)}>Back</button>
                    <button className="primary-button" disabled={busy || selectedCount === 0} onClick={() => void startCopy()}>Start Copy</button>
                    {isCopying && <button className="danger-button" onClick={() => void cancelCopy()}>Cancel Copy</button>}
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function CopyReviewPanel({
  shoots,
  progressByShoot,
  destinationCount,
  copying,
  disabled,
  onToggle,
  onRename
}: {
  shoots: ShootItem[];
  progressByShoot: Record<string, BatchCopyStatus>;
  destinationCount: number;
  copying: boolean;
  disabled: boolean;
  onToggle: (shootId: string) => void;
  onRename: (shootId: string, folderName: string) => void;
}) {
  const multiplier = Math.max(1, destinationCount);

  return (
    <aside className="copy-review-panel">
      <div className="panel-heading compact-heading">
        <div>
          <p className="eyebrow">Copy review</p>
          <h3>Selected batches</h3>
        </div>
      </div>

      {shoots.length === 0 ? (
        <div className="copy-review-empty">No batches selected for copying.</div>
      ) : (
        <div className="copy-review-list">
          {shoots.map(shoot => {
            const progress = progressByShoot[shoot.id];
            const total = progress?.total ?? shoot.photos.length * multiplier;
            const completed = Math.min(progress?.completed ?? 0, total);
            const bytesTotal = progress?.bytesTotal ?? totalSize(shoot.photos) * multiplier;
            const bytesCompleted = Math.min(progress?.bytesCompleted ?? 0, bytesTotal);
            const percent = bytesTotal === 0 ? (total === 0 ? 0 : (completed / total) * 100) : (bytesCompleted / bytesTotal) * 100;
            return (
              <article className={`copy-review-item ${shoot.include ? "" : "is-skipped"}`} key={shoot.id}>
                <div className="copy-review-topline">
                  <label className="copy-review-check">
                    <input type="checkbox" checked={shoot.include} disabled={disabled} onChange={() => onToggle(shoot.id)} />
                    <span>Batch {shoot.index}</span>
                  </label>
                  <span>{completed}/{total}</span>
                </div>
                <input
                  className="copy-review-name"
                  disabled={disabled || !shoot.include}
                  value={shoot.folderName}
                  onChange={event => onRename(shoot.id, event.target.value)}
                  aria-label={`Rename batch ${shoot.index} folder`}
                />
                <div className="copy-review-meta">
                  <span>{shoot.photos.length} files</span>
                  <span>{formatBytes(totalSize(shoot.photos))}</span>
                </div>
                <div className="batch-progress-track">
                  <div className="batch-progress-fill" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
                </div>
                <p>
                  {progress
                    ? `${progress.destinationLabel}: ${progress.currentFile}`
                    : copying
                      ? "Waiting to copy"
                      : shoot.include ? "Ready" : "Will not copy"}
                  {progress?.activeFiles ? ` · ${progress.activeFiles} active` : ""}
                </p>
              </article>
            );
          })}
        </div>
      )}
    </aside>
  );
}

function ProgressArea({ scanProgress, copyProgress, status }: { scanProgress: ScanProgress | null; copyProgress: CopyProgress | null; status: string }) {
  const percent = copyProgress?.percent ?? scanProgress?.percent ?? 0;
  const hasProgress = Boolean(copyProgress || scanProgress);
  const label = copyProgress
    ? `${copyProgress.completed}/${copyProgress.total} photos completed`
    : scanProgress
      ? `${scanProgress.phase} ${scanProgress.total ? `${scanProgress.processed}/${scanProgress.total}` : ""}`
      : status;

  return (
    <div className="progress-card">
      <div className="progress-copy">
        <span>{label}</span>
        {hasProgress && <span>{status}</span>}
      </div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
      </div>
      {copyProgress && (
        <div className="copy-stats">
          <span>Elapsed {copyProgress.elapsed}</span>
          <span>Current {copyProgress.currentSpeed}</span>
          <span>Average {copyProgress.averageSpeed}</span>
        </div>
      )}
    </div>
  );
}

function ShootCard({
  shoot,
  canMerge,
  collapsed,
  busy,
  batchGapMinutes,
  onToggle,
  onRename,
  onSplit,
  onMerge,
  onBatchGapChange,
  onRecalculateBatch,
  onToggleCollapse
}: {
  shoot: ShootItem;
  canMerge: boolean;
  collapsed: boolean;
  busy: boolean;
  batchGapMinutes: number;
  onToggle: () => void;
  onRename: (folderName: string) => void;
  onSplit: (photo: PhotoItem) => void;
  onMerge: () => void;
  onBatchGapChange: (value: number) => void;
  onRecalculateBatch: () => void;
  onToggleCollapse: () => void;
}) {
  const previews = representativePhotos(shoot.photos);
  const normalizedBatchGap = Number.isFinite(batchGapMinutes) ? Math.max(1, Math.round(batchGapMinutes)) : 1;

  return (
    <article className={`shoot-card ${shoot.include ? "" : "is-skipped"}`}>
      <div className="shoot-header">
        <label className="copy-check">
          <input type="checkbox" checked={shoot.include} onChange={onToggle} />
          <span>{shoot.include ? "Copy" : "Skip"}</span>
        </label>
        <div>
          <h3>Batch {shoot.index}</h3>
          <p>{formatRange(shoot)}</p>
        </div>
      </div>

      <div className="meta-row">
        <span>{shoot.photos.length} files</span>
        <span>{formatBytes(totalSize(shoot.photos))}</span>
      </div>

      <label className="folder-field">
        <span>Folder name</span>
        <input value={shoot.folderName} onChange={event => onRename(event.target.value)} />
      </label>

      {shoot.splitFromPrevious && (
        <div className="split-note">
          Split point: {shoot.splitFromPrevious.previous.name} to {shoot.splitFromPrevious.current.name}
        </div>
      )}

      <div className="batch-gap-card">
        <div>
          <strong>Re-adjust this batch</strong>
          <span>Try a different time gap only inside this batch, then rebuild its previews.</span>
        </div>
        <div className="mini-gap-control">
          <input
            type="number"
            min={1}
            disabled={busy}
            value={normalizedBatchGap}
            onChange={event => onBatchGapChange(Number(event.target.value))}
          />
          <span>min</span>
          <div className="gap-stepper" aria-label={`Adjust batch ${shoot.index} gap`}>
            <button type="button" disabled={busy} aria-label="Increase batch gap" onClick={() => onBatchGapChange(normalizedBatchGap + 1)}>▲</button>
            <button type="button" disabled={busy} aria-label="Decrease batch gap" onClick={() => onBatchGapChange(normalizedBatchGap - 1)}>▼</button>
          </div>
          <button type="button" disabled={busy} onClick={onRecalculateBatch}>Recalculate</button>
        </div>
      </div>

      <div className="card-footer">
        <span>{timeSourceSummary(shoot.photos)}</span>
        <div className="batch-actions">
          <button className="collapse-button" onClick={onToggleCollapse}>
            {collapsed ? "Show previews" : "Hide previews"}
          </button>
          {canMerge && <button className="merge-button" onClick={onMerge}>Merge with previous</button>}
        </div>
      </div>

      {!collapsed && (
        <div className="preview-grid">
          {previews.map((photo, index) => (
            <div className="preview-card" key={photo.path}>
              <div className="preview-media">
                {shoot.previewPaths[photo.path] ? <img src={fileUrl(shoot.previewPaths[photo.path])} alt={photo.name} /> : <span>No preview</span>}
              </div>
              <div className="preview-body">
                <strong>{photo.name}</strong>
                <span>{photoTime(photo)}</span>
                {index > 0 ? <button onClick={() => onSplit(photo)}>Split Here</button> : <span className="start-label">Start</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
