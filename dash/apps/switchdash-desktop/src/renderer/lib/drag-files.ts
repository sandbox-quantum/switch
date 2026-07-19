export function hasDraggedFiles(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes('Files');
}

export function getDraggedFilePaths(dataTransfer: DataTransfer): string[] {
  return Array.from(dataTransfer.files)
    .map((file) => window.electronAPI.getPathForFile(file).trim())
    .filter(Boolean);
}

/**
 * In-app drags of location files (e.g. from the editor file tree) are tagged
 * with this MIME type. Custom types must be lowercase; browsers lowercase
 * `DataTransfer.types`.
 */
export const LOCATION_FILE_DRAG_TYPE = 'application/x-switchdash-location-file';

export type DraggedLocationFile = {
  locationId: string;
  relPath: string;
  /** Absolute path in the location environment where the target agent runs. */
  targetPath: string;
  /** Remote locations are Linux targets even when the renderer runs elsewhere. */
  targetPlatform?: NodeJS.Platform;
};

type DraggedLocationFileInput = {
  locationId: string;
  locationRootPath: string;
  relPath: string;
  targetPlatform?: NodeJS.Platform;
};

// Electron/Chromium can mangle custom-MIME payloads on drop (getData returns
// whitespace), so the payload also travels through this module-level store —
// drag source and same-window drop targets share the renderer. Consumers still
// require the DataTransfer marker so stale state from a previous drag cannot be
// accepted by an unrelated drop.
let draggedLocationFile: DraggedLocationFile | null = null;

export function resolveLocationFileTargetPath(rootPath: string, relPath: string): string {
  const separator = rootPath.includes('\\') ? '\\' : '/';
  const normalizedRoot = rootPath.replace(/[\\/]+$/, '');
  const normalizedPath = relPath.replace(/^[\\/]+/, '').replace(/[\\/]+/g, separator);
  return `${normalizedRoot}${separator}${normalizedPath}`;
}

export function setDraggedLocationFile(
  dataTransfer: DataTransfer,
  input: DraggedLocationFileInput
): void {
  const payload: DraggedLocationFile = {
    locationId: input.locationId,
    relPath: input.relPath,
    targetPath: resolveLocationFileTargetPath(input.locationRootPath, input.relPath),
    targetPlatform: input.targetPlatform,
  };

  draggedLocationFile = payload;
  dataTransfer.setData(LOCATION_FILE_DRAG_TYPE, JSON.stringify(payload));
  dataTransfer.setData('text/plain', payload.targetPath);
  dataTransfer.effectAllowed = 'copy';
}

/** Call on dragend; drop fires on the target before dragend on the source. */
export function clearDraggedLocationFile(): void {
  draggedLocationFile = null;
}

/** True when this transfer is tagged as an in-app location-file drag. */
export function hasDraggedLocationFile(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(LOCATION_FILE_DRAG_TYPE);
}

const NODE_PLATFORMS = new Set<NodeJS.Platform>([
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
  'cygwin',
  'netbsd',
]);

function isNodePlatform(value: unknown): value is NodeJS.Platform {
  return typeof value === 'string' && NODE_PLATFORMS.has(value as NodeJS.Platform);
}

function isDraggedLocationFile(value: unknown): value is DraggedLocationFile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DraggedLocationFile>;
  return (
    typeof candidate.locationId === 'string' &&
    typeof candidate.relPath === 'string' &&
    typeof candidate.targetPath === 'string' &&
    (candidate.targetPlatform === undefined || isNodePlatform(candidate.targetPlatform))
  );
}

export function getDraggedLocationFile(dataTransfer: DataTransfer): DraggedLocationFile | null {
  if (!hasDraggedLocationFile(dataTransfer)) return null;
  if (draggedLocationFile) return draggedLocationFile;

  try {
    const parsed: unknown = JSON.parse(dataTransfer.getData(LOCATION_FILE_DRAG_TYPE));
    return isDraggedLocationFile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
