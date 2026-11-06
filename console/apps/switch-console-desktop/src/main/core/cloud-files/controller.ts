import { dialog } from 'electron';
import { getMainWindow } from '@main/app/window';
import { featureFlagsService } from '@main/core/feature-flags/feature-flags';
import { withReachableServerWorkspaceSession } from '@main/core/workspaces/workspace-session';
import {
  type CloudFileListing,
  type CloudFilesCode,
  CloudFilesError,
  IMAGE_PREVIEW_MAX_BYTES,
  looksLikeText,
  type NoPreviewReason,
  previewKind,
  safeSuggestedName,
  TEXT_PREVIEW_MAX_BYTES,
  VIDEO_PREVIEW_MAX_BYTES,
  videoTypeFromBytes,
  zipSuggestedName,
} from '@shared/core/cloud-files/cloud-files';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { listCloudFiles, openCloudZip, readCloudFile, readCloudFileChunks } from './gateway';
import { saveToDisk } from './save';

/** What a cloud-files call gives the renderer: the answer, or a fixed code to show. */
export type CloudFilesResult<T> = { ok: true; value: T } | { ok: false; code: CloudFilesCode };

/** A file's preview, decided from its name and size, then checked against its bytes. */
export type CloudFilePreview =
  | { kind: 'image'; mimeType: string; data: string }
  | { kind: 'video'; mimeType: 'video/mp4' | 'video/webm'; data: string }
  | { kind: 'text' | 'markdown' | 'json'; text: string }
  | { kind: 'csv'; text: string; delimiter: ',' | '\t' }
  | { kind: 'code'; text: string; language: string }
  | { kind: 'download'; reason: NoPreviewReason };

/**
 * Whether this server serves Your cloud files: a good flags read with both
 * `hosted_v2` and `hosted_cloud_files` on. Checked here as well as in the
 * renderer, so with either off Console calls none of the routes.
 */
export async function cloudFilesOn(server: SwitchServer): Promise<boolean> {
  const state = await featureFlagsService.current(server);
  const readOk = state.fetchedAt !== null && state.error === null;
  return readOk && state.flags.hosted_v2 && state.flags.hosted_cloud_files;
}

async function onServer<T>(
  serverId: string,
  fn: (server: SwitchServer) => Promise<T>
): Promise<CloudFilesResult<T>> {
  try {
    return {
      ok: true,
      value: await withReachableServerWorkspaceSession(serverId, async (server) => {
        if (!(await cloudFilesOn(server))) throw new CloudFilesError('no_files');
        return fn(server);
      }),
    };
  } catch (error) {
    if (error instanceof CloudFilesError) return { ok: false, code: error.code };
    throw error;
  }
}

async function chooseTarget(suggestedName: string): Promise<string | null> {
  const win = getMainWindow();
  if (!win) return null;
  const result = await dialog.showSaveDialog(win, { defaultPath: suggestedName });
  return result.canceled || !result.filePath ? null : result.filePath;
}

export const cloudFilesController = createRPCController({
  /** One page of a folder. `path` is box-relative; '' is the top level. */
  list: (params: {
    serverId: string;
    path: string;
    cursor?: string;
  }): Promise<CloudFilesResult<CloudFileListing>> =>
    onServer(params.serverId, (server) => listCloudFiles(server, params.path, params.cursor)),

  /**
   * A file to show inside Console: one of the four safe image types, an mp4 or
   * webm whose opening bytes match, or text, code, Markdown, JSON or CSV that
   * really is text. Anything else, or anything too big, is `download`, and its
   * bytes are never fetched for a preview. Only the file asked for is read.
   */
  preview: (params: {
    serverId: string;
    path: string;
    name: string;
    size: number;
  }): Promise<CloudFilesResult<CloudFilePreview>> =>
    onServer(params.serverId, async (server): Promise<CloudFilePreview> => {
      const kind = previewKind(params.name, params.size);
      if (kind.kind === 'download') return kind;
      const max =
        kind.kind === 'image'
          ? IMAGE_PREVIEW_MAX_BYTES
          : kind.kind === 'video'
            ? VIDEO_PREVIEW_MAX_BYTES
            : TEXT_PREVIEW_MAX_BYTES;
      const bytes = await readCloudFile(server, params.path, max);
      const data = () => Buffer.from(bytes).toString('base64');
      if (kind.kind === 'image') return { kind: 'image', mimeType: kind.mimeType, data: data() };
      if (kind.kind === 'video') {
        // The extension says video; the bytes must say the same, or it's download only.
        const mimeType = videoTypeFromBytes(bytes, kind.mimeType);
        return mimeType
          ? { kind: 'video', mimeType, data: data() }
          : { kind: 'download', reason: 'type' };
      }
      if (!looksLikeText(bytes)) return { kind: 'download', reason: 'type' };
      const text = new TextDecoder('utf-8').decode(bytes);
      if (kind.kind === 'csv') return { kind: 'csv', text, delimiter: kind.delimiter };
      if (kind.kind === 'code') return { kind: 'code', text, language: kind.language };
      return { kind: kind.kind, text };
    }),

  /** Saves one file where the person chooses. False when they cancelled. */
  saveFile: (params: {
    serverId: string;
    path: string;
    name: string;
  }): Promise<CloudFilesResult<boolean>> =>
    onServer(params.serverId, async (server) => {
      const saved = await saveToDisk(
        safeSuggestedName(params.name, 'file'),
        async () => readCloudFileChunks(server, params.path),
        { chooseTarget }
      );
      return saved !== null;
    }),

  /** Saves a folder as a zip. `caches` includes `node_modules` and the like. */
  saveZip: (params: {
    serverId: string;
    path: string;
    name: string;
    caches: boolean;
  }): Promise<CloudFilesResult<boolean>> =>
    onServer(params.serverId, async (server) => {
      const saved = await saveToDisk(
        zipSuggestedName(params.name),
        () => openCloudZip(server, params.path, params.caches),
        { chooseTarget }
      );
      return saved !== null;
    }),
});
