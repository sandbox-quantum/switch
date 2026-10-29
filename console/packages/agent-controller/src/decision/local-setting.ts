import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigurationError } from '../errors';

/**
 * Where the decision model's files live in the controller's data directory:
 * the weights (`models/<sha256>.gguf`, and `.part` while downloading), the
 * llama.cpp build (`runtime/`), and the owner's own switch for decision work
 * on this machine (`settings.json`).
 */
export function decisionLayout(dataDir: string) {
  const root = join(dataDir, 'decision');
  return {
    root,
    models: join(root, 'models'),
    runtime: join(root, 'runtime'),
    settings: join(root, 'settings.json'),
    pidFile: join(root, 'model-server.pid'),
  };
}

export type DecisionLayout = ReturnType<typeof decisionLayout>;

/**
 * Whether the owner allows decision work on this machine, as they last set
 * it here: on unless turned off. A file that cannot be read counts as off,
 * the safer reading of a setting someone wrote: `problem` says why.
 */
export async function readLocalSetting(
  layout: DecisionLayout
): Promise<{ enabled: boolean; problem: string | null }> {
  let text: string;
  try {
    text = await readFile(layout.settings, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { enabled: true, problem: null };
    return { enabled: false, problem: `${layout.settings} cannot be read: ${String(error)}` };
  }
  try {
    const parsed = JSON.parse(text) as { enabled?: unknown };
    if (typeof parsed.enabled === 'boolean') return { enabled: parsed.enabled, problem: null };
  } catch {}
  return { enabled: false, problem: `${layout.settings} does not say {"enabled": true|false}` };
}

export async function writeLocalSetting(layout: DecisionLayout, enabled: boolean): Promise<void> {
  await mkdir(layout.root, { recursive: true, mode: 0o700 });
  const temporary = `${layout.settings}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ enabled })}\n`, { mode: 0o600 });
  await rename(temporary, layout.settings);
}

/** Deletes the downloaded weights and llama.cpp build, partial downloads included. */
export async function removeDownloads(layout: DecisionLayout): Promise<void> {
  await rm(layout.models, { recursive: true, force: true });
  await rm(layout.runtime, { recursive: true, force: true });
}

/** Set by whoever starts the controller (Switch Console, on every start): `on` or `off`. */
export const DECISION_MODEL_ENV = 'SWITCH_CONTROLLER_DECISION_MODEL';

/**
 * What this run says of decision work, over the owner's switch in the data
 * directory: `off` with `--no-decision-model` or `SWITCH_CONTROLLER_DECISION_MODEL=off`,
 * `on` with that variable `on`, null (follow the switch) when neither says.
 * Any other value of the variable is a configuration error.
 */
export function decisionModelOverride(flag: boolean, env: NodeJS.ProcessEnv): 'on' | 'off' | null {
  const value = env[DECISION_MODEL_ENV]?.trim().toLowerCase();
  if (value !== undefined && value !== '' && value !== 'on' && value !== 'off')
    throw new ConfigurationError(
      `${DECISION_MODEL_ENV} must be on or off, not '${env[DECISION_MODEL_ENV]}'.`
    );
  if (flag || value === 'off') return 'off';
  return value === 'on' ? 'on' : null;
}
