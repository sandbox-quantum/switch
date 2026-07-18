import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';

/**
 * PTY file/link click handlers. switchdash has no in-app file editor, so a
 * file-path click is a no-op; external (http/https) links open in the OS
 * browser after a confirmation prompt. (Replaces the old editor-backed
 * `open-file-in-file-editor` handlers.)
 */
export function makeFileLinkHandlers(
  _locationId: string,
  _sessionId: string
): { onOpenFile: (filePath: string) => void; onOpenExternal: (filePath: string) => void } {
  return {
    onOpenFile: () => {},
    onOpenExternal: (filePath: string) => confirmOpenExternalLink(filePath),
  };
}
