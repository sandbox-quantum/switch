import { useCallback, useEffect, useRef, useState } from "react";
import { useFeatureFlags } from "../../data/hooks";
import { fetchBoxAgentIds, listCloudFiles, wakeBox } from "../../data/cloudFiles";
import {
  type CloudFileEntry,
  type CloudFilesCode,
  CloudFilesError,
  cloudFilesMessage,
  showsCloudFiles,
} from "./cloudFiles";

/**
 * Whether Your cloud files shows: both `hosted_v2` and `hosted_cloud_files`
 * on, and an agent on the person's v2 box. Null while that's being found
 * out. Until it's true, none of the cloud-files routes is called.
 */
export function useCloudFilesShown(): boolean | null {
  const box = useCloudFilesBox();
  return box === null ? null : box.shown;
}

/**
 * Your cloud files' visibility plus the agent ids on the box, for View files.
 * Null while being found out; nothing about the box is asked unless both
 * flags are on.
 */
export function useCloudFilesBox(): { shown: boolean; agentIds: readonly string[] } | null {
  const flags = useFeatureFlags();
  const v2 = flags.data?.hosted_v2 === true;
  const files = flags.data?.hosted_cloud_files === true;
  const [agentIds, setAgentIds] = useState<string[] | null>(null);
  useEffect(() => {
    if (!v2 || !files) return;
    let current = true;
    void fetchBoxAgentIds().then((ids) => current && setAgentIds(ids));
    return () => {
      current = false;
    };
  }, [v2, files]);
  if (flags.loading && flags.data === null) return null;
  if (!v2 || !files) return { shown: false, agentIds: [] };
  if (agentIds === null) return null;
  return {
    shown: showsCloudFiles({ hostedV2: v2, cloudFiles: files, hasHostedAgent: agentIds.length > 0 }),
    agentIds,
  };
}

export type FolderState =
  | { kind: "loading" }
  | { kind: "ready"; entries: CloudFileEntry[]; more: boolean }
  | { kind: "resting" }
  | { kind: "waking" }
  | { kind: "error"; message: string };

export const WAKE_RETRY_MS = 3_000;
export const WAKE_GIVE_UP_MS = 4 * 60_000;
export const WAKE_FAILED_MESSAGE =
  "Your cloud couldn’t be woken. Start it from Your cloud on the Agents page, then try again.";

function codeOf(error: unknown): CloudFilesCode {
  return error instanceof CloudFilesError ? error.code : "unknown";
}

/**
 * One folder, and the box's state around it. `wake` is the person's "Wake
 * it": one ensure, never more for this folder, then the listing tried again
 * every few seconds until the box answers or time runs out.
 */
export function useFolder(path: string, enabled: boolean) {
  const [state, setState] = useState<FolderState>({ kind: "loading" });
  const cursor = useRef<string | undefined>(undefined);
  const generation = useRef(0);
  const woke = useRef(false);

  const load = useCallback(
    async (from: "start" | "more", mine: number): Promise<CloudFilesCode | null> => {
      try {
        const page = await listCloudFiles(path, from === "more" ? cursor.current : undefined);
        if (mine !== generation.current) return null;
        cursor.current = page.cursor;
        setState((now) => ({
          kind: "ready",
          entries: from === "more" && now.kind === "ready" ? [...now.entries, ...page.entries] : page.entries,
          more: page.cursor !== undefined,
        }));
        return null;
      } catch (error) {
        return mine === generation.current ? codeOf(error) : null;
      }
    },
    [path],
  );

  const show = useCallback((code: CloudFilesCode) => {
    setState(code === "box_resting" ? { kind: "resting" } : { kind: "error", message: cloudFilesMessage(code) });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const mine = ++generation.current;
    cursor.current = undefined;
    setState({ kind: "loading" });
    void load("start", mine).then((code) => {
      if (code && mine === generation.current) show(code);
    });
    // Leaving the folder (or the page) ends a wake's retries too: each listing
    // counts as the box's awake time, so none runs for a page nobody has open.
    return () => {
      generation.current += 1;
    };
  }, [enabled, path, load, show]);

  const loadMore = useCallback(async () => {
    const code = await load("more", generation.current);
    if (code) show(code);
  }, [load, show]);

  const wake = useCallback(async () => {
    if (woke.current) return;
    woke.current = true;
    const mine = generation.current;
    setState({ kind: "waking" });
    try {
      await wakeBox();
    } catch {
      if (mine === generation.current) setState({ kind: "error", message: WAKE_FAILED_MESSAGE });
      return;
    }
    const giveUp = Date.now() + WAKE_GIVE_UP_MS;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, WAKE_RETRY_MS));
      if (mine !== generation.current) return;
      const code = await load("start", mine);
      if (code === null) return;
      if (code !== "box_resting" && code !== "files_elsewhere" && code !== "unreachable") {
        show(code);
        return;
      }
      if (Date.now() >= giveUp) {
        setState({ kind: "error", message: cloudFilesMessage("timeout") });
        return;
      }
    }
  }, [load, show]);

  return { state, loadMore, wake };
}
