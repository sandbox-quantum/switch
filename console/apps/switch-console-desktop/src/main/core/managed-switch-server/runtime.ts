import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { LocalServerRuntime } from "@shared/core/managed-switch-server/managed-switch-server";
import { COMPOSE_FILE_NAME, ENV_FILE_NAME } from "./constants";

const RUNTIME_FILE = "runtime.json";

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * How this machine's local server runs.
 *
 * New installs run natively — PostgreSQL and switch-core as plain processes, no
 * Docker. A server set up before that, which left its compose file and `.env`
 * in the directory, stays on Docker: its data is in a Docker volume, and
 * moving it is not something to do behind the user's back. Resetting such a
 * server (which deletes its data anyway) is what moves it to native.
 */
export async function readLocalRuntime(dir: string): Promise<LocalServerRuntime> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, RUNTIME_FILE), "utf8")) as {
      runtime?: unknown;
    };
    if (parsed.runtime === "docker" || parsed.runtime === "native") return parsed.runtime;
    throw new Error(`${path.join(dir, RUNTIME_FILE)} names no runtime this build knows.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const dockerInstall =
    (await exists(path.join(dir, COMPOSE_FILE_NAME))) ||
    (await exists(path.join(dir, ENV_FILE_NAME)));
  return dockerInstall ? "docker" : "native";
}

export async function writeLocalRuntime(dir: string, runtime: LocalServerRuntime): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, RUNTIME_FILE), `${JSON.stringify({ runtime }, null, 2)}\n`);
}
