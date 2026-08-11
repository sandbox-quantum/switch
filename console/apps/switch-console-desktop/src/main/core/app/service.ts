import { exec } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import type { IDisposable, IInitializable } from '@switch-console/shared';
import { app, clipboard, dialog, shell } from 'electron';
import { getMainWindow } from '@main/app/window';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { buildExternalToolEnv } from '@main/utils/childProcessEnv';
import { appPasteChannel, appRedoChannel, appUndoChannel } from '@shared/events/appEvents';
import {
  getAppById,
  getResolvedLabel,
  OPEN_IN_APPS,
  type OpenInAppId,
  type PlatformConfig,
  type PlatformKey,
} from '@shared/openInApps';
import {
  checkCommand,
  checkMacApp,
  checkMacAppByName,
  checkMacMdfindQuery,
  listInstalledFontsAll,
  resolveAppVersion,
} from './utils';

const FONT_CACHE_TTL_MS = 5 * 60 * 1_000;
const MAX_AUDIO_FILE_BYTES = 20 * 1024 * 1024;

const AUDIO_MIME_TYPES: Record<string, string> = {
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
};

function expandAbsoluteOrTildePath(rawPath: string): string {
  if (!rawPath || typeof rawPath !== 'string') throw new Error('Invalid path');
  const expanded = rawPath.startsWith('~/') ? join(homedir(), rawPath.slice(2)) : rawPath;
  if (!isAbsolute(expanded)) throw new Error('Path must be absolute or start with ~/');
  return expanded;
}

async function resolveHomeJailedPath(rawPath: string): Promise<string> {
  const expanded = expandAbsoluteOrTildePath(rawPath);
  const realPath = await realpath(expanded);
  const realHome = await realpath(homedir());
  const realHomeWithSep = realHome.endsWith(sep) ? realHome : realHome + sep;
  if (realPath !== realHome && !realPath.startsWith(realHomeWithSep)) {
    throw new Error('Path must be inside the user home directory');
  }
  return realPath;
}

class AppService implements IInitializable, IDisposable {
  private cachedAppVersion: string | null = null;
  private cachedAppVersionPromise: Promise<string> | null = null;
  private cachedInstalledFonts: { fonts: string[]; fetchedAt: number } | null = null;
  private _unsubscribes: Array<() => void> = [];

  initialize(): void {
    void this.getCachedAppVersion();

    this._unsubscribes = [
      events.on(appUndoChannel, () => {
        getMainWindow()?.webContents.undo();
      }),
      events.on(appRedoChannel, () => {
        getMainWindow()?.webContents.redo();
      }),
      events.on(appPasteChannel, () => {
        getMainWindow()?.webContents.paste();
      }),
    ];
  }

  dispose(): void {
    for (const unsub of this._unsubscribes) unsub();
    this._unsubscribes = [];
  }

  getCachedAppVersion(): Promise<string> {
    if (this.cachedAppVersion) return Promise.resolve(this.cachedAppVersion);
    if (!this.cachedAppVersionPromise) {
      this.cachedAppVersionPromise = resolveAppVersion().then((version) => {
        this.cachedAppVersion = version;
        return version;
      });
    }
    return this.cachedAppVersionPromise;
  }

  async listInstalledFonts(
    refresh?: boolean
  ): Promise<{ fonts: string[]; cached: boolean; error?: string }> {
    const now = Date.now();
    if (
      !refresh &&
      this.cachedInstalledFonts &&
      now - this.cachedInstalledFonts.fetchedAt < FONT_CACHE_TTL_MS
    ) {
      return { fonts: this.cachedInstalledFonts.fonts, cached: true };
    }
    try {
      const fonts = await listInstalledFontsAll();
      this.cachedInstalledFonts = { fonts, fetchedAt: now };
      return { fonts, cached: false };
    } catch (error) {
      return {
        fonts: this.cachedInstalledFonts?.fonts ?? [],
        cached: Boolean(this.cachedInstalledFonts),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async checkInstalledApps(): Promise<Record<string, boolean>> {
    const platform = process.platform as PlatformKey;
    const availability: Record<string, boolean> = {};

    for (const openInApp of Object.values(OPEN_IN_APPS)) {
      const platformConfig = openInApp.platforms[platform];
      if (!platformConfig && !openInApp.alwaysAvailable) {
        availability[openInApp.id] = false;
        continue;
      }
      if (openInApp.alwaysAvailable) {
        availability[openInApp.id] = true;
        continue;
      }
      try {
        let isAvailable = false;
        if (platformConfig?.bundleIds) {
          for (const bundleId of platformConfig.bundleIds) {
            if (await checkMacApp(bundleId)) {
              isAvailable = true;
              break;
            }
          }
        }
        if (!isAvailable && platformConfig?.appNames) {
          for (const appName of platformConfig.appNames) {
            if (await checkMacAppByName(appName)) {
              isAvailable = true;
              break;
            }
          }
        }
        if (!isAvailable && platformConfig?.checkCommands) {
          for (const cmd of platformConfig.checkCommands) {
            if (await checkCommand(cmd)) {
              isAvailable = true;
              break;
            }
          }
        }
        if (!isAvailable && platformConfig?.mdfindQuery && platform === 'darwin') {
          isAvailable = await checkMacMdfindQuery(platformConfig.mdfindQuery);
        }
        availability[openInApp.id] = isAvailable;
      } catch (error) {
        log.error(`Error checking installed app ${openInApp.id}:`, error);
        availability[openInApp.id] = false;
      }
    }

    return availability;
  }

  async openExternal(url: string): Promise<void> {
    if (!url || typeof url !== 'string') throw new Error('Invalid URL');
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error('Invalid URL format');
    }
    // http/https plus the messaging-app schemes used by the sidebar "open in
    // Slack/Mattermost/Telegram" room deeplinks (links the gateway builds from
    // a room's bridge); other schemes (file:, javascript:, …) stay blocked.
    if (!['http:', 'https:', 'slack:', 'mattermost:', 'tg:'].includes(parsedUrl.protocol)) {
      throw new Error(
        `Protocol "${parsedUrl.protocol}" is not allowed. Only http, https, ` +
          `slack, mattermost and tg URLs are permitted.`
      );
    }
    await shell.openExternal(url);
  }

  async openPath(rawPath: string): Promise<void> {
    const realPath = await resolveHomeJailedPath(rawPath);
    const errorMessage = await shell.openPath(realPath);
    if (errorMessage) throw new Error(errorMessage);
  }

  /**
   * Restricted to the user home directory: terminal output drives these reads,
   * and AI-injected paths must not be a vector for reading e.g. `/etc/passwd`.
   * Symlinks are resolved before the home-jail check so they can't escape.
   */
  async readUserFile(rawPath: string, maxBytes = 1_048_576): Promise<{ content: string }> {
    const realPath = await resolveHomeJailedPath(rawPath);
    const stats = await stat(realPath);
    if (stats.size > maxBytes) {
      throw new Error(`File too large (${stats.size} bytes, max ${maxBytes})`);
    }
    const buffer = await readFile(realPath);
    return { content: buffer.toString('utf8') };
  }

  clipboardWriteText(text: string): void {
    if (typeof text !== 'string') throw new Error('Invalid clipboard text');
    clipboard.writeText(text);
  }

  quit(): void {
    app.quit();
  }

  async openIn(args: { app: OpenInAppId; path: string }): Promise<void> {
    const { path: target, app: appId } = args;

    if (!target || typeof target !== 'string' || !appId) {
      throw new Error('Invalid arguments');
    }

    const platform = process.platform as PlatformKey;
    const appConfig = getAppById(appId);
    if (!appConfig) throw new Error('Invalid app ID');

    const platformConfig = appConfig.platforms?.[platform];
    const label = getResolvedLabel(appConfig, platform);

    if (!platformConfig && !appConfig.alwaysAvailable) {
      throw new Error(`${label} is not available on this platform.`);
    }

    await this.openInLocal({ appId, label, target, platformConfig });
  }

  private async openInLocal(args: {
    appId: OpenInAppId;
    label: string;
    target: string;
    platformConfig: PlatformConfig | undefined;
  }): Promise<void> {
    const { appId, label, target, platformConfig } = args;

    if (appId === 'finder') {
      const errorMessage = await shell.openPath(target);
      if (errorMessage) throw new Error(errorMessage);
      return;
    }

    if (platformConfig?.openUrls) {
      for (const urlTemplate of platformConfig.openUrls) {
        const url = urlTemplate
          .replace('{{path_url}}', encodeURIComponent(target))
          .replace('{{path}}', target);
        try {
          await shell.openExternal(url);
          return;
        } catch {
          // try next URL
        }
      }
      throw new Error(
        `${label} is not installed or its URI scheme is not registered on this platform.`
      );
    }

    const quoted = (p: string) =>
      process.platform !== 'win32' ? `'${p.replace(/'/g, "'\\''")}'` : `"${p.replace(/"/g, '""')}"`;
    const commands: string[] = platformConfig?.openCommands ?? [];
    const command = commands
      .map((cmd) => cmd.replace('{{path}}', quoted(target)).replace('{{path_raw}}', target))
      .join(' || ');

    if (!command) throw new Error('Unsupported platform or app');

    await new Promise<void>((resolve, reject) => {
      exec(command, { cwd: target, env: buildExternalToolEnv() }, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  async openSelectDirectoryDialog(args: {
    title: string;
    message: string;
    defaultPath?: string;
  }): Promise<string | undefined> {
    const result = await dialog.showOpenDialog(getMainWindow()!, {
      title: args.title,
      properties: ['openDirectory'],
      message: args.message,
      defaultPath: args.defaultPath,
    });
    if (result.canceled) return undefined;
    return result.filePaths[0];
  }

  async openSelectAudioFileDialog(args: {
    title: string;
    message: string;
  }): Promise<string | undefined> {
    const result = await dialog.showOpenDialog(getMainWindow()!, {
      title: args.title,
      properties: ['openFile'],
      message: args.message,
      filters: [
        {
          name: 'Audio',
          extensions: ['aac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav', 'webm'],
        },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled) return undefined;
    return result.filePaths[0];
  }

  async readAudioFileDataUrl(filePath: string): Promise<string> {
    if (!filePath || typeof filePath !== 'string') throw new Error('Invalid audio path');

    const resolvedPath = await realpath(resolve(filePath));
    const resolvedHome = resolve(homedir());
    const homePrefix = resolvedHome.endsWith(sep) ? resolvedHome : `${resolvedHome}${sep}`;
    if (!resolvedPath.startsWith(homePrefix) && resolvedPath !== resolvedHome) {
      throw new Error('Audio file must be located within the user home directory');
    }

    const extension = extname(filePath).toLowerCase();
    const mimeType = AUDIO_MIME_TYPES[extension];
    if (!mimeType) throw new Error('Unsupported audio file type');

    const fileStat = await stat(resolvedPath);
    if (!fileStat.isFile()) throw new Error('Audio path is not a file');
    if (fileStat.size > MAX_AUDIO_FILE_BYTES) throw new Error('Audio file is larger than 20 MB');

    const file = await readFile(resolvedPath);
    return `data:${mimeType};base64,${file.toString('base64')}`;
  }
}

export const appService = new AppService();
