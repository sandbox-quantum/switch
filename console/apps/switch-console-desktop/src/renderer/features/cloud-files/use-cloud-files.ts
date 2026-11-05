import { useCallback, useEffect, useRef, useState } from 'react';
import { useCloudMachines } from '@renderer/features/cloud-agents/use-cloud-agents';
import { useAnsweredFlags } from '@renderer/features/switch-buddy/use-this-computer';
import { rpc } from '@renderer/lib/ipc';
import {
  type CloudFileEntry,
  type CloudFilesCode,
  cloudFilesMessage,
  hasHostedAgent,
  showsCloudFiles,
} from '@shared/core/cloud-files/cloud-files';

/**
 * Whether Your cloud files shows for this server: a good flags read with
 * `hosted_v2` and `hosted_cloud_files` on, and at least one hosted agent.
 * Until then nothing is asked of the cloud-files routes.
 */
export function useCloudFilesVisible(serverId: string | null): boolean {
  const answer = useAnsweredFlags(serverId);
  const v2 = answer.readOk && answer.flags?.hosted_v2 === true;
  const machines = useCloudMachines(v2 ? serverId : null);
  return showsCloudFiles({
    flagsReadOk: answer.readOk,
    hostedV2: answer.flags?.hosted_v2 === true,
    cloudFiles: answer.flags?.hosted_cloud_files === true,
    hasHostedAgent: hasHostedAgent(machines.data),
  });
}

/** How often a woken box's listing is tried again, and for how long in all. */
export const WAKE_RETRY_MS = 3_000;
export const WAKE_GIVE_UP_MS = 4 * 60_000;

/**
 * One folder of Your cloud files, and the box's state around it:
 * `loading`, `ready` (with its entries so far and whether there are more),
 * `resting` (asleep: the person may wake it), `waking` (the one ensure was
 * sent; the listing is tried again until it answers), or `error` with a
 * plain message.
 */
export type CloudFolderState =
  | { kind: 'loading' }
  | { kind: 'ready'; entries: CloudFileEntry[]; more: boolean }
  | { kind: 'resting' }
  | { kind: 'waking' }
  | { kind: 'error'; code: CloudFilesCode | 'wake_failed'; message: string };

export const WAKE_FAILED_MESSAGE =
  'Your cloud couldn’t be woken. Start it from the Your cloud card, then try again.';

export function useCloudFolder(serverId: string | null, path: string, enabled: boolean) {
  const [state, setState] = useState<CloudFolderState>({ kind: 'loading' });
  const cursor = useRef<string | undefined>(undefined);
  const generation = useRef(0);
  const woke = useRef(false);
  /** The folder's current run: ended when the folder changes or the view closes. */
  const run = useRef<{ live: boolean }>({ live: false });

  const load = useCallback(
    async (from: 'start' | 'more', mine: number): Promise<CloudFilesCode | null> => {
      if (!serverId) return null;
      const result = await rpc.cloudFiles.list({
        serverId,
        path,
        ...(from === 'more' && cursor.current ? { cursor: cursor.current } : {}),
      });
      if (mine !== generation.current) return null;
      if (!result.ok) return result.code;
      cursor.current = result.value.cursor;
      setState((now) => ({
        kind: 'ready',
        entries:
          from === 'more' && now.kind === 'ready'
            ? [...now.entries, ...result.value.entries]
            : result.value.entries,
        more: result.value.cursor !== undefined,
      }));
      return null;
    },
    [serverId, path]
  );

  const show = useCallback((code: CloudFilesCode) => {
    setState(
      code === 'box_resting'
        ? { kind: 'resting' }
        : { kind: 'error', code, message: cloudFilesMessage(code) }
    );
  }, []);

  useEffect(() => {
    if (!enabled || !serverId) return;
    const mine = ++generation.current;
    cursor.current = undefined;
    setState({ kind: 'loading' });
    void load('start', mine).then((code) => {
      if (code && mine === generation.current) show(code);
    });
    // Leaving the folder or closing the view ends a wake's retries: each listing
    // counts as the box's awake time.
    const current = { live: true };
    run.current = current;
    return () => {
      current.live = false;
    };
  }, [enabled, serverId, path, load, show]);

  const loadMore = useCallback(async () => {
    const code = await load('more', generation.current);
    if (code) show(code);
  }, [load, show]);

  /**
   * The person's "Wake it": one ensure, never more for this folder, then the
   * listing again every few seconds until the box answers or time runs out.
   * A refused wake (a paused box, say) says so plainly and stops.
   */
  const wake = useCallback(async () => {
    if (!serverId || woke.current) return;
    woke.current = true;
    const mine = generation.current;
    const current = run.current;
    setState({ kind: 'waking' });
    try {
      await rpc.switchServers.ensureCloudMachine(serverId);
    } catch {
      if (mine === generation.current)
        setState({ kind: 'error', code: 'wake_failed', message: WAKE_FAILED_MESSAGE });
      return;
    }
    const giveUp = Date.now() + WAKE_GIVE_UP_MS;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, WAKE_RETRY_MS));
      if (!current.live || mine !== generation.current) return;
      const code = await load('start', mine);
      if (code === null) return;
      if (code !== 'box_resting' && code !== 'files_elsewhere' && code !== 'unreachable') {
        show(code);
        return;
      }
      if (Date.now() >= giveUp) {
        setState({ kind: 'error', code: 'timeout', message: cloudFilesMessage('timeout') });
        return;
      }
    }
  }, [serverId, load, show]);

  return { state, loadMore, wake };
}
