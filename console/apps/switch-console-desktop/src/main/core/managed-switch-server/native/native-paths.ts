import path from "node:path";

/**
 * Where a native local server keeps everything, under the local server's own
 * directory (`<userData>/local-switch-server/native`). One root so a reset can
 * remove the server's data without guessing, and so nothing of it lands in
 * the user's home directory or system locations.
 */
export type NativeLayout = {
  root: string;
  /** Downloaded tools: `postgres-<version>/`, `uv-<version>/`. */
  toolchain: string;
  /** Temporary downloads, removed once unpacked. */
  downloads: string;
  /** uv's own cache and the Pythons it installs, kept out of the user's. */
  uvCache: string;
  uvPython: string;
  /** Unpacked switch-core sources and their environments, one per version. */
  switchCore: string;
  /** The Postgres cluster's data directory. */
  pgdata: string;
  /** Log files for Postgres and switch-core. */
  logs: string;
  /** Pid and state files for the processes this Console started. */
  run: string;
  /** Copies of the data directory taken before an update. */
  backups: string;
};

export function nativeLayout(localServerDir: string): NativeLayout {
  const root = path.join(localServerDir, "native");
  return {
    root,
    toolchain: path.join(root, "toolchain"),
    downloads: path.join(root, "downloads"),
    uvCache: path.join(root, "toolchain", "uv-cache"),
    uvPython: path.join(root, "toolchain", "python"),
    switchCore: path.join(root, "switch-core"),
    pgdata: path.join(root, "pgdata"),
    logs: path.join(root, "logs"),
    run: path.join(root, "run"),
    backups: path.join(root, "backups"),
  };
}

/** An executable's file name on this platform. */
export function exe(name: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `${name}.exe` : name;
}
