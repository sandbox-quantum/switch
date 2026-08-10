import { beforeEach, describe, expect, it } from 'vitest';
import {
  bindLogContext,
  clearLogContextResolvers,
  getRunId,
  registerLogContextResolver,
  resolveLogContext,
  runWithLogContext,
} from './log-context';

beforeEach(() => {
  clearLogContextResolvers();
});

describe('runWithLogContext', () => {
  it('makes context visible to code that was never passed it', () => {
    const deep = () => resolveLogContext(undefined);

    const resolved = runWithLogContext({ sessionId: 'session-1' }, () => deep());

    expect(resolved.sessionId).toBe('session-1');
  });

  it('survives await boundaries', async () => {
    const resolved = await runWithLogContext({ sessionId: 'session-1' }, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      return resolveLogContext(undefined);
    });

    expect(resolved.sessionId).toBe('session-1');
  });

  it('keeps concurrent scopes separate', async () => {
    const run = (id: string) =>
      runWithLogContext({ sessionId: id }, async () => {
        await new Promise((resolve) => setTimeout(resolve, id === 'slow' ? 10 : 1));
        return resolveLogContext(undefined).sessionId;
      });

    const [slow, fast] = await Promise.all([run('slow'), run('fast')]);

    expect(slow).toBe('slow');
    expect(fast).toBe('fast');
  });

  it('nests, with the inner scope winning', () => {
    const resolved = runWithLogContext({ sessionId: 'outer', component: 'a' }, () =>
      runWithLogContext({ sessionId: 'inner' }, () => resolveLogContext(undefined))
    );

    expect(resolved.sessionId).toBe('inner');
    expect(resolved.component).toBe('a');
  });

  it('does not leak outside the scope', () => {
    runWithLogContext({ sessionId: 'session-1' }, () => undefined);

    expect(resolveLogContext(undefined).sessionId).toBeUndefined();
  });
});

describe('bindLogContext', () => {
  it('re-applies a captured scope to a callback invoked outside it', () => {
    const callback = runWithLogContext({ sessionId: 'session-1' }, () =>
      bindLogContext(() => resolveLogContext(undefined).sessionId)
    );

    expect(callback()).toBe('session-1');
  });
});

describe('resolveLogContext', () => {
  it('stamps every entry with the run id', () => {
    expect(resolveLogContext(undefined).runId).toBe(getRunId());
  });

  it('prefers the entry context over the ambient scope', () => {
    const resolved = runWithLogContext({ sessionId: 'ambient' }, () =>
      resolveLogContext({ sessionId: 'explicit' })
    );

    expect(resolved.sessionId).toBe('explicit');
  });

  it('fills gaps from a registered resolver', () => {
    registerLogContextResolver((context) =>
      context.sessionId === 'session-1' ? { roomId: 'room-1', roomName: 'General' } : undefined
    );

    const resolved = resolveLogContext({ sessionId: 'session-1' });

    expect(resolved.roomId).toBe('room-1');
    expect(resolved.roomName).toBe('General');
  });

  it('never lets a resolver overwrite a value from the call site', () => {
    registerLogContextResolver(() => ({ roomName: 'derived' }));

    expect(resolveLogContext({ roomName: 'explicit' }).roomName).toBe('explicit');
  });

  it('lets a later resolver build on an earlier one', () => {
    registerLogContextResolver(() => ({ agentId: 'agent-1' }));
    registerLogContextResolver((context) =>
      context.agentId === 'agent-1' ? { agentName: 'Ada' } : undefined
    );

    expect(resolveLogContext({ sessionId: 'session-1' }).agentName).toBe('Ada');
  });

  it('keeps the entry when a resolver throws', () => {
    registerLogContextResolver(() => {
      throw new Error('resolver exploded');
    });
    registerLogContextResolver(() => ({ roomId: 'room-1' }));

    const resolved = resolveLogContext({ sessionId: 'session-1' });

    expect(resolved.sessionId).toBe('session-1');
    expect(resolved.roomId).toBe('room-1');
  });
});
