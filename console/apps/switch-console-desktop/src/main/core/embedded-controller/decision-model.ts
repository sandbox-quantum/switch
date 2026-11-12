import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { replaceFile } from '@switch-console/agent-providers';
import { z } from 'zod';

/**
 * Whether this computer's controller may run auto-route's decision model,
 * handed to it in its environment at every start: `on` or `off`. Off, the
 * controller refuses decision work and reports the model `off` with the
 * reason `turned_off_on_machine`, as `--no-decision-model` does on a
 * headless one.
 */
export const DECISION_MODEL_ENV = 'SWITCH_CONTROLLER_DECISION_MODEL';

/**
 * Console asking its own controller, over the controller's IPC channel, to
 * delete the decision model it downloaded. It answers with the same `id`, and
 * `error` null once the files are gone or the reason it could not.
 */
export const DECISION_MODEL_REMOVE_KIND = 'switch-decision-model-remove';
export const DECISION_MODEL_REMOVED_KIND = 'switch-decision-model-removed';

export type DecisionModelRemoveRequest = { kind: typeof DECISION_MODEL_REMOVE_KIND; id: string };

export type DecisionModelRemoveReply = {
  kind: typeof DECISION_MODEL_REMOVED_KIND;
  id: string;
  error: string | null;
};

export function isDecisionModelRemoveReply(raw: unknown): raw is DecisionModelRemoveReply {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { kind?: unknown }).kind === DECISION_MODEL_REMOVED_KIND &&
    typeof (raw as { id?: unknown }).id === 'string'
  );
}

/**
 * A controller that does not know the request ignores it, so silence is how
 * an older one answers.
 */
export const DECISION_MODEL_UNSUPPORTED =
  'Removing the downloaded model is not supported by this controller version. Update Switch Console to get one that does.';

/** Where the choice is kept between launches. */
export interface DecisionModelPreference {
  /** On unless turned off here. */
  enabled(): Promise<boolean>;
  setEnabled(enabled: boolean): Promise<void>;
}

const preferenceSchema = z.object({ version: z.literal(1), enabled: z.boolean() });

/** `decision-model.json` beside the controllers' `state.json`, written whole. */
export class DecisionModelPreferenceFile implements DecisionModelPreference {
  /** `path` is resolved on first use: the user-data directory is not settled at import time. */
  constructor(private readonly path: () => string) {}

  async enabled(): Promise<boolean> {
    let text: string;
    try {
      text = await readFile(this.path(), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
    const parsed = preferenceSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.enabled : true;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const path = this.path();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify({ version: 1, enabled }, null, 2));
      await file.sync();
    } finally {
      await file.close();
    }
    await replaceFile(temporary, path);
  }
}
