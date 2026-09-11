import { expect, it, vi } from 'vitest';
import type { InitialPromptDelivery } from '@shared/core/sessions/session-config';
import {
  isCommandNotFound,
  reconcileInitialPrompt,
  type CommandLookup,
  type CommandReceipt,
  type ReconcileInitialPromptInput,
} from './initial-prompt';

function harness(overrides: Partial<ReconcileInitialPromptInput>) {
  const persisted: InitialPromptDelivery[] = [];
  const input: ReconcileInitialPromptInput = {
    prompt: 'Say hello',
    epoch: 'epoch-2',
    record: undefined,
    legacyCommandId: 'initial-session-1',
    hasPriorActivity: false,
    lookup: vi.fn(async (): Promise<CommandLookup> => ({ recorded: false })),
    persist: vi.fn(async (record: InitialPromptDelivery) => {
      persisted.push(record);
    }),
    submit: vi.fn(async (): Promise<CommandReceipt> => accepted),
    newCommandId: () => 'minted-id',
    now: () => '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
  return { input, persisted, run: () => reconcileInitialPrompt(input) };
}

const accepted: CommandReceipt = {
  recorded: true,
  status: 'accepted',
  code: null,
  message: null,
};

const applied = (commandId: string): CommandLookup => ({
  recorded: true,
  status: 'applied',
  code: null,
  message: commandId,
});

it('submits under a minted id and records the delivery when nothing is recorded yet', async () => {
  const h = harness({});
  const outcome = await h.run();
  expect(h.input.submit).toHaveBeenCalledWith('minted-id', 'epoch-2');
  expect(outcome).toEqual({
    action: 'submitted',
    record: {
      commandId: 'minted-id',
      state: 'submitted',
      attemptedAt: '2026-01-01T00:00:00.000Z',
      epoch: 'epoch-2',
    },
  });
  expect(h.persisted.map((r) => r.state)).toEqual(['pending', 'submitted']);
});

it('resubmits a pending attempt under its own id when the server never recorded it', async () => {
  const h = harness({
    record: { commandId: 'attempt-1', state: 'pending', epoch: 'epoch-1' },
  });
  const outcome = await h.run();
  expect(h.input.lookup).toHaveBeenCalledWith('attempt-1');
  expect(h.input.submit).toHaveBeenCalledWith('attempt-1', 'epoch-1');
  expect(outcome.action).toBe('submitted');
});

it('resubmits a pending attempt under the epoch it was minted for', async () => {
  const h = harness({
    epoch: 'epoch-9',
    record: { commandId: 'attempt-1', state: 'pending', epoch: 'epoch-1' },
  });
  await h.run();
  expect(h.input.submit).toHaveBeenCalledWith('attempt-1', 'epoch-1');
  expect(h.persisted.map((r) => r.epoch)).toEqual(['epoch-1', 'epoch-1']);
});

it('does not resubmit a pending attempt that saved no epoch', async () => {
  const h = harness({ record: { commandId: 'attempt-1', state: 'pending' } });
  const outcome = await h.run();
  expect(h.input.submit).not.toHaveBeenCalled();
  expect(outcome).toEqual({
    action: 'unresolved',
    record: {
      commandId: 'attempt-1',
      state: 'unknown',
      reason: 'saved attempt has no epoch',
    },
  });
  expect(h.persisted.map((r) => r.state)).toEqual(['unknown']);
});

it('records the receipt of a submission the server refused', async () => {
  const h = harness({
    submit: vi.fn(
      async (): Promise<CommandReceipt> => ({
        recorded: true,
        status: 'rejected',
        code: 'STALE_EPOCH',
        message: 'The epoch has moved on.',
      })
    ),
  });
  const outcome = await h.run();
  expect(outcome).toEqual({
    action: 'rejected',
    record: {
      commandId: 'minted-id',
      state: 'rejected',
      attemptedAt: '2026-01-01T00:00:00.000Z',
      epoch: 'epoch-2',
      code: 'STALE_EPOCH',
      message: 'The epoch has moved on.',
    },
  });
  expect(h.persisted.map((r) => r.state)).toEqual(['pending', 'rejected']);
});

it('leaves a submission the server answered as unknown unresolved', async () => {
  const h = harness({
    submit: vi.fn(
      async (): Promise<CommandReceipt> => ({
        recorded: true,
        status: 'unknown',
        code: 'HOST_UNREACHABLE',
        message: 'The host did not answer.',
      })
    ),
  });
  const outcome = await h.run();
  expect(outcome).toMatchObject({
    action: 'unresolved',
    record: {
      commandId: 'minted-id',
      state: 'unknown',
      code: 'HOST_UNREACHABLE',
      message: 'The host did not answer.',
    },
  });
  expect(outcome.action === 'unresolved' && outcome.record.reason).toBeTruthy();
  expect(h.persisted.map((r) => r.state)).toEqual(['pending', 'unknown']);
});

it('leaves a lookup the server answered as unknown unresolved', async () => {
  const h = harness({
    record: { commandId: 'attempt-1', state: 'pending', epoch: 'epoch-1' },
    lookup: vi.fn(
      async (): Promise<CommandLookup> => ({
        recorded: true,
        status: 'unknown',
        code: 'HOST_UNREACHABLE',
        message: 'The host did not answer.',
      })
    ),
  });
  const outcome = await h.run();
  expect(h.input.submit).not.toHaveBeenCalled();
  expect(outcome).toMatchObject({
    action: 'unresolved',
    record: {
      commandId: 'attempt-1',
      state: 'unknown',
      code: 'HOST_UNREACHABLE',
      message: 'The host did not answer.',
    },
  });
  expect(h.persisted.map((r) => r.state)).toEqual(['unknown']);
});

it('adopts a recorded command instead of resending a pending prompt', async () => {
  const h = harness({
    record: { commandId: 'attempt-1', state: 'pending', epoch: 'epoch-1' },
    lookup: vi.fn(async () => applied('attempt-1')),
  });
  const outcome = await h.run();
  expect(h.input.submit).not.toHaveBeenCalled();
  expect(outcome).toEqual({
    action: 'adopted',
    record: { commandId: 'attempt-1', state: 'submitted', epoch: 'epoch-1' },
  });
});

it('adopts a recorded command when the previous outcome was unknown', async () => {
  const h = harness({
    record: { commandId: 'attempt-1', state: 'unknown', reason: 'timed out' },
    lookup: vi.fn(async () => applied('attempt-1')),
  });
  const outcome = await h.run();
  expect(h.input.submit).not.toHaveBeenCalled();
  expect(outcome.action).toBe('adopted');
  expect(outcome).toMatchObject({ record: { state: 'submitted' } });
});

it('leaves an unknown delivery unresolved rather than resending it', async () => {
  const h = harness({
    record: { commandId: 'attempt-1', state: 'unknown', reason: 'timed out' },
  });
  const outcome = await h.run();
  expect(h.input.submit).not.toHaveBeenCalled();
  expect(h.input.persist).not.toHaveBeenCalled();
  expect(outcome).toEqual({
    action: 'unresolved',
    record: { commandId: 'attempt-1', state: 'unknown', reason: 'timed out' },
  });
});

it('records a pending id the server rejected and does not submit under a new one', async () => {
  const h = harness({
    record: { commandId: 'attempt-1', state: 'pending', epoch: 'epoch-1' },
    lookup: vi.fn(
      async (): Promise<CommandLookup> => ({
        recorded: true,
        status: 'rejected',
        code: 'STALE_EPOCH',
        message: 'The epoch has moved on.',
      })
    ),
  });
  const outcome = await h.run();
  expect(h.input.submit).not.toHaveBeenCalled();
  expect(outcome).toEqual({
    action: 'rejected',
    record: {
      commandId: 'attempt-1',
      state: 'rejected',
      epoch: 'epoch-1',
      code: 'STALE_EPOCH',
      message: 'The epoch has moved on.',
    },
  });
});

it('reports an already rejected delivery without asking the server again', async () => {
  const h = harness({
    record: { commandId: 'attempt-1', state: 'rejected', code: 'STALE_EPOCH' },
  });
  const outcome = await h.run();
  expect(h.input.lookup).not.toHaveBeenCalled();
  expect(h.input.submit).not.toHaveBeenCalled();
  expect(outcome.action).toBe('rejected');
});

it('records the delivery as unknown when the submit call fails', async () => {
  const h = harness({
    submit: vi.fn(async () => {
      throw new Error('gateway is unreachable');
    }),
  });
  await expect(h.run()).rejects.toThrow('gateway is unreachable');
  expect(h.persisted.map((r) => r.state)).toEqual(['pending', 'unknown']);
  expect(h.persisted[1].reason).toContain('gateway is unreachable');
});

it('does nothing when the session has no initial prompt', async () => {
  const h = harness({ prompt: '   ' });
  expect(await h.run()).toEqual({ action: 'skip' });
  expect(h.input.lookup).not.toHaveBeenCalled();
  expect(h.input.submit).not.toHaveBeenCalled();
});

it('does nothing when the prompt was already submitted', async () => {
  const h = harness({ record: { commandId: 'attempt-1', state: 'submitted' } });
  expect(await h.run()).toEqual({ action: 'skip' });
  expect(h.input.lookup).not.toHaveBeenCalled();
});

it('adopts a legacy fixed id the server already holds', async () => {
  const h = harness({ lookup: vi.fn(async () => applied('initial-session-1')) });
  const outcome = await h.run();
  expect(h.input.lookup).toHaveBeenCalledWith('initial-session-1');
  expect(h.input.submit).not.toHaveBeenCalled();
  expect(outcome).toEqual({
    action: 'adopted',
    record: { commandId: 'initial-session-1', state: 'submitted' },
  });
});

it('submits under a minted id when the legacy id is absent and the transcript is empty', async () => {
  const h = harness({});
  const outcome = await h.run();
  expect(h.input.lookup).toHaveBeenCalledWith('initial-session-1');
  expect(outcome).toMatchObject({ action: 'submitted', record: { commandId: 'minted-id' } });
});

it('does not submit when the legacy id is absent but the conversation already has turns', async () => {
  const h = harness({ hasPriorActivity: true });
  const outcome = await h.run();
  expect(h.input.submit).not.toHaveBeenCalled();
  expect(outcome.action).toBe('unresolved');
  expect(h.persisted).toEqual([
    {
      commandId: 'initial-session-1',
      state: 'unknown',
      attemptedAt: '2026-01-01T00:00:00.000Z',
      epoch: 'epoch-2',
      reason: 'The conversation already holds turns from before delivery was recorded.',
    },
  ]);
});

it('does not submit when the legacy lookup fails', async () => {
  const h = harness({
    lookup: vi.fn(async () => {
      throw new Error('gateway timed out');
    }),
  });
  const outcome = await h.run();
  expect(h.input.submit).not.toHaveBeenCalled();
  expect(outcome.action).toBe('unresolved');
  expect(h.persisted[0]).toMatchObject({ commandId: 'initial-session-1', state: 'unknown' });
  expect(h.persisted[0].reason).toContain('gateway timed out');
});

it('reads a not-found command from the gateway failure body', () => {
  expect(
    isCommandNotFound({
      status: 404,
      message: 'Switch gateway returned 404: {"code":"NOT_FOUND","message":"No such command"}',
    })
  ).toBe(true);
});

it('does not read another 404 code as a not-found command', () => {
  expect(
    isCommandNotFound({
      status: 404,
      message: 'Switch gateway returned 404: {"code":"NOT_AUTHORIZED","message":"No"}',
    })
  ).toBe(false);
});

it('does not read a 404 with an unparseable body as a not-found command', () => {
  expect(
    isCommandNotFound({ status: 404, message: 'Switch gateway returned 404: <html>nope</html>' })
  ).toBe(false);
});

it('does not read another status as a not-found command', () => {
  expect(
    isCommandNotFound({ status: 409, message: 'Switch gateway returned 409: {"code":"NOT_FOUND"}' })
  ).toBe(false);
});
