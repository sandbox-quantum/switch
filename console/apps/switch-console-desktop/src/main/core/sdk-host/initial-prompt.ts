import type { InitialPromptDelivery } from '@shared/core/sessions/session-config';

export type CommandReceipt = {
  recorded: true;
  status: 'accepted' | 'dispatched' | 'applied' | 'rejected' | 'unknown';
  code: string | null;
  message: string | null;
};

export type CommandLookup = { recorded: false } | CommandReceipt;

export type InitialPromptOutcome =
  | { action: 'skip' }
  | { action: 'submitted'; record: InitialPromptDelivery }
  | { action: 'adopted'; record: InitialPromptDelivery }
  | { action: 'unresolved'; record: InitialPromptDelivery }
  | { action: 'rejected'; record: InitialPromptDelivery };

export type ReconcileInitialPromptInput = {
  prompt: string | undefined;
  epoch: string;
  record: InitialPromptDelivery | undefined;
  /** The fixed `initial-<sessionId>` id a Console without a delivery record used. */
  legacyCommandId: string;
  /** Whether the session already holds turns or items, so the conversation is
   *  not the fresh one an initial prompt is meant to open. */
  hasPriorActivity: boolean;
  lookup: (commandId: string) => Promise<CommandLookup>;
  persist: (record: InitialPromptDelivery) => Promise<void>;
  /** Submits the prompt under `commandId` for `epoch` and answers with the
   *  server's receipt, which decides the recorded state. */
  submit: (commandId: string, epoch: string) => Promise<CommandReceipt>;
  newCommandId: () => string;
  now: () => string;
};

/**
 * Whether a gateway failure says the command id is absent, rather than leaving
 * its fate uncertain. The gateway keeps the server's JSON body as the tail of
 * the message, after the status line.
 */
export function isCommandNotFound(error: { status?: number; message?: string }): boolean {
  const message = error.message;
  if (error.status !== 404 || message === undefined) return false;
  const separator = message.indexOf(': ');
  if (separator < 0) return false;
  try {
    const body = JSON.parse(message.slice(separator + 2)) as { code?: unknown } | null;
    return body?.code === 'NOT_FOUND';
  } catch {
    return false;
  }
}

function adopt(
  commandId: string,
  base: InitialPromptDelivery | undefined,
  found: CommandReceipt
): InitialPromptDelivery {
  if (found.status === 'rejected')
    return {
      ...base,
      commandId,
      state: 'rejected',
      code: found.code ?? undefined,
      message: found.message ?? undefined,
    };
  if (found.status === 'unknown')
    return {
      ...base,
      commandId,
      state: 'unknown',
      code: found.code ?? undefined,
      message: found.message ?? undefined,
      reason: 'The server reports the outcome of this command as unknown.',
    };
  return { ...base, commandId, state: 'submitted' };
}

function settle(
  record: InitialPromptDelivery,
  delivered: 'adopted' | 'submitted'
): InitialPromptOutcome {
  if (record.state === 'rejected') return { action: 'rejected', record };
  if (record.state === 'unknown') return { action: 'unresolved', record };
  return { action: delivered, record };
}

/**
 * Decide whether a session's initial prompt still has to reach the host, from
 * the saved delivery record and what the server holds under the id it names.
 * `unknown` and `rejected` are terminal: a duplicate prompt is worse than a
 * missing one, and a refused id is immutable.
 */
export async function reconcileInitialPrompt(
  input: ReconcileInitialPromptInput
): Promise<InitialPromptOutcome> {
  if (!input.prompt?.trim()) return { action: 'skip' };
  const record = input.record;
  if (record?.state === 'submitted') return { action: 'skip' };
  if (record?.state === 'rejected') return { action: 'rejected', record };

  if (record) {
    const found = await input.lookup(record.commandId);
    if (found.recorded) {
      const resolved = adopt(record.commandId, record, found);
      await input.persist(resolved);
      return settle(resolved, 'adopted');
    }
    if (record.state === 'unknown') return { action: 'unresolved', record };
    // An id the server never recorded was never spent, so a `pending` attempt
    // keeps its own id rather than minting another — and goes out under the
    // epoch it was minted for, because the server judges it against that one.
    if (!record.epoch) {
      const stalled: InitialPromptDelivery = {
        ...record,
        state: 'unknown',
        reason: 'saved attempt has no epoch',
      };
      await input.persist(stalled);
      return { action: 'unresolved', record: stalled };
    }
    return attempt(input, record.commandId, record.epoch);
  }

  const unresolved = async (reason: string): Promise<InitialPromptOutcome> => {
    const stalled: InitialPromptDelivery = {
      commandId: input.legacyCommandId,
      state: 'unknown',
      attemptedAt: input.now(),
      epoch: input.epoch,
      reason,
    };
    await input.persist(stalled);
    return { action: 'unresolved', record: stalled };
  };

  let legacy: CommandLookup;
  try {
    legacy = await input.lookup(input.legacyCommandId);
  } catch (error) {
    return unresolved(
      `Could not read the status of ${input.legacyCommandId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (legacy.recorded) {
    const resolved = adopt(input.legacyCommandId, undefined, legacy);
    await input.persist(resolved);
    return settle(resolved, 'adopted');
  }
  if (input.hasPriorActivity)
    return unresolved('The conversation already holds turns from before delivery was recorded.');

  return attempt(input, input.newCommandId(), input.epoch);
}

async function attempt(
  input: ReconcileInitialPromptInput,
  commandId: string,
  epoch: string
): Promise<InitialPromptOutcome> {
  const pending: InitialPromptDelivery = {
    commandId,
    state: 'pending',
    attemptedAt: input.now(),
    epoch,
  };
  await input.persist(pending);
  let receipt: CommandReceipt;
  try {
    receipt = await input.submit(commandId, epoch);
  } catch (error) {
    await input.persist({ ...pending, state: 'unknown', reason: String(error) });
    throw error;
  }
  const resolved = adopt(commandId, pending, receipt);
  await input.persist(resolved);
  return settle(resolved, 'submitted');
}
