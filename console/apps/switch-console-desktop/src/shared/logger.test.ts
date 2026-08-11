import { describe, expect, it, vi } from 'vitest';
import { createLogger, formatContextForConsole, type LogSinkEntry } from './logger';

function collect() {
  const entries: LogSinkEntry[] = [];
  return { entries, sink: (entry: LogSinkEntry) => entries.push(entry) };
}

describe('createLogger levels', () => {
  it('records to the sink below the console level', () => {
    const { entries, sink } = collect();
    const log = createLogger({ envLevel: 'warn', sinkLevel: 'info', sink });

    log.info('boot complete');

    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe('info');
  });

  it('keeps the console quiet while the sink records', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { sink } = collect();
    const log = createLogger({ envLevel: 'warn', sinkLevel: 'info', sink });

    log.info('boot complete');

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('drops entries below the sink level', () => {
    const { entries, sink } = collect();
    const log = createLogger({ envLevel: 'warn', sinkLevel: 'info', sink });

    log.debug('noisy');

    expect(entries).toHaveLength(0);
  });

  it('always records errors regardless of level', () => {
    const { entries, sink } = collect();
    const log = createLogger({ envLevel: 'error', sinkLevel: 'error', sink });

    log.error('exploded');

    expect(entries).toHaveLength(1);
  });

  it('defaults the sink level to the console level when unset', () => {
    const log = createLogger({ envLevel: 'warn' });

    expect(log.sinkLevel).toBe('warn');
  });
});

describe('child loggers', () => {
  it('attaches bound context to every entry', () => {
    const { entries, sink } = collect();
    const log = createLogger({ envLevel: 'debug', sink }).child({ component: 'updater' });

    log.info('checking');

    expect(entries[0]?.context).toMatchObject({ component: 'updater' });
  });

  it('merges nested children, innermost winning', () => {
    const { entries, sink } = collect();
    const log = createLogger({ envLevel: 'debug', sink })
      .child({ component: 'updater', sessionId: 'session-1' })
      .child({ component: 'updater:download' });

    log.info('downloading');

    expect(entries[0]?.context).toMatchObject({
      component: 'updater:download',
      sessionId: 'session-1',
    });
  });

  it('does not mutate the parent logger', () => {
    const { entries, sink } = collect();
    const parent = createLogger({ envLevel: 'debug', sink });
    parent.child({ component: 'child-only' });

    parent.info('from parent');

    expect(entries[0]?.context?.component).toBeUndefined();
  });

  it('lets bound context override the ambient provider', () => {
    const { entries, sink } = collect();
    const log = createLogger({
      envLevel: 'debug',
      sink,
      contextProvider: () => ({ sessionId: 'ambient' }),
    }).child({ sessionId: 'bound' });

    log.info('hello');

    expect(entries[0]?.context?.sessionId).toBe('bound');
  });
});

describe('sink failures', () => {
  it('reports rather than swallows them', () => {
    const onSinkError = vi.fn();
    const log = createLogger({
      envLevel: 'debug',
      sink: () => {
        throw new Error('disk full');
      },
      onSinkError,
    });

    expect(() => log.info('hello')).not.toThrow();
    expect(onSinkError).toHaveBeenCalledOnce();
  });
});

describe('console context rendering', () => {
  it('appends identity to console output when enabled', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const log = createLogger({ envLevel: 'debug', consoleContext: true }).child({
      component: 'hook-relay',
      agentName: 'freebsd_vt',
      sessionId: 'ac3bee1e-bb1d-47ba-809c-75ed35d46df7',
    });

    log.info('received events');

    expect(spy).toHaveBeenCalledWith(
      'received events',
      '[hook-relay agent=freebsd_vt session=ac3bee1e]'
    );
    spy.mockRestore();
  });

  it('stays silent about context when not enabled', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const log = createLogger({ envLevel: 'debug' }).child({ component: 'hook-relay' });

    log.info('received events');

    expect(spy).toHaveBeenCalledWith('received events');
    spy.mockRestore();
  });

  it('shows the name instead of the id when both are known', () => {
    expect(formatContextForConsole({ agentId: 'abcdef12-3456', agentName: 'freebsd_vt' })).toBe(
      '[agent=freebsd_vt]'
    );
  });

  it('falls back to a shortened id when there is no name', () => {
    expect(formatContextForConsole({ agentId: 'abcdef12-3456' })).toBe('[agent=abcdef12]');
  });

  it('renders nothing when there is nothing worth showing', () => {
    expect(formatContextForConsole({ runId: 'only-a-run-id' })).toBe('');
  });
});
