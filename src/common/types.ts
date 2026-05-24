export const APP_NAME = "aDrop";
export const DEFAULT_GAP_MINUTES = 30;
export const DEFAULT_PRESET = "RAW, EDITED";
export const PARALLEL_COPY_WORKERS = 6;

export type DestinationKind = string;

export interface PhotoItem {
  path: string;
  name: string;
  captureDatetime: string;
  size: number;
  timeSource: string;
}

export interface SplitMarker {
  previous: PhotoItem;
  current: PhotoItem;
}

export interface ShootItem {
  id: string;
  index: number;
  photos: PhotoItem[];
  folderName: string;
  include: boolean;
  splitFromPrevious?: SplitMarker;
  previewPaths: Record<string, string>;
}

export interface InitialPaths {
  source: string;
  dropbox: string;
}

export interface ScanProgress {
  phase: "finding" | "metadata" | "batching" | "preview" | "report" | "recalculating";
  processed: number;
  total: number;
  currentFile?: string;
  percent: number;
}

export interface ScanResult {
  photos: PhotoItem[];
  shoots: ShootItem[];
  reportPath: string;
  message: string;
  metadataRead: number;
  metadataReused: number;
}

export interface RecalculateRequest {
  source: string;
  photos: PhotoItem[];
  gapMinutes: number;
  previewPaths: Record<string, string>;
}

export interface RecalculateResult {
  shoots: ShootItem[];
  reportPath: string;
  message: string;
}

export interface EnsurePreviewsRequest {
  shoots: ShootItem[];
}

export interface EnsurePreviewsResult {
  shoots: ShootItem[];
}

export interface CopyDestination {
  label: DestinationKind;
  path: string;
}

export interface CopyRequest {
  source: string;
  shoots: ShootItem[];
  destinations: CopyDestination[];
  subfolders: string[];
  renameCopies: boolean;
}

export interface CopyProgress {
  completed: number;
  total: number;
  percent: number;
  bytesCompleted: number;
  bytesTotal: number;
  shootId: string;
  shootIndex: number;
  shootFolderName: string;
  shootCompleted: number;
  shootTotal: number;
  shootBytesCompleted: number;
  shootBytesTotal: number;
  activeFiles: number;
  currentFile: string;
  destinationLabel: DestinationKind;
  elapsed: string;
  currentSpeed: string;
  averageSpeed: string;
}

export interface CopyResult {
  message: string;
  errors: number;
}

export interface AppApi {
  getInitialPaths: () => Promise<InitialPaths>;
  chooseDirectory: () => Promise<string | null>;
  scanSource: (source: string, gapMinutes: number) => Promise<ScanResult>;
  recalculateBatches: (request: RecalculateRequest) => Promise<RecalculateResult>;
  ensurePreviews: (request: EnsurePreviewsRequest) => Promise<EnsurePreviewsResult>;
  startCopy: (request: CopyRequest) => Promise<CopyResult>;
  cancelCopy: () => Promise<void>;
  onScanProgress: (callback: (progress: ScanProgress) => void) => () => void;
  onCopyProgress: (callback: (progress: CopyProgress) => void) => () => void;
}
