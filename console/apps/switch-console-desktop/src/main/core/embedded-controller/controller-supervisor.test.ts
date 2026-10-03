import { describe, expect, it } from 'vitest';
import type { EmbeddedControllerPhase } from '@shared/core/embedded-controller/embedded-controller';
import {
  type ControllerLaunch,
  type ControllerLogLevel,
  ControllerSupervisor,
} from './controller-supervisor';
import { fakeSpawn, waitFor } from './test-helpers/fake-controller-child';

const NOW = Date.parse('2026-01-01T00:00:00Z');

function harness(launch: () => Promise<ControllerLaunch> = async () => LAUNCH) {
  const { spawn, calls } = fakeSpawn();
  const phases: EmbeddedControllerPhase[] = [];
  const finals: string[] = [];
  const lines: [ControllerLogLevel, string][] = [];
  const supervisor = new ControllerSupervisor({
    spawn,
    launch,
    onPhase: (phase) => phases.push(phase),
    onFinal: (exit) => finals.push(exit),
    onLine: (level, line) => lines.push([level, line]),
    now: () => NOW,
    backoff: { initialMs: 10, maxMs: 40, stableMs: 10_000 },
  });
  return { supervisor, calls, phases, finals, lines };
}

const LAUNCH: ControllerLaunch = {
  executable: '/electron',
  args: ['/bundle.mjs', 'run'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
  credential: 'swcc_placeholder',
};

describe('ControllerSupervisor', () => {
  it('hands the credential over on stdin and closes it', async () => {
    const { supervisor, calls, phases } = harness();
    supervisor.start();
    await waitFor(() => calls.length === 1, 'the spawn');
    const child = calls[0]!.child;
    await waitFor(() => child.stdin.writableEnded, 'stdin closed');
    expect(child.received).toBe('swcc_placeholder');
    expect(calls[0]!.args).not.toContain('swcc_placeholder');
    expect(phases.at(-1)).toEqual({ kind: 'running', since: '2026-01-01T00:00:00.000Z' });
    await supervisor.stop(1_000);
  });

  it('restarts a controller that exits on its own, backing off up to the cap', async () => {
    const { supervisor, calls, phases } = harness();
    supervisor.start();
    const delays: number[] = [];
    for (let run = 1; run <= 4; run++) {
      await waitFor(() => calls.length === run, `start ${run}`);
      calls[run - 1]!.child.say('2026-01-01T00:00:00.000Z ERROR Something broke {"x":1}');
      await new Promise((resolve) => setTimeout(resolve, 5));
      calls[run - 1]!.child.exit(1);
      const restarting = phases.at(-1);
      if (restarting?.kind !== 'restarting') throw new Error(`not restarting: ${restarting?.kind}`);
      expect(restarting.attempt).toBe(run);
      expect(restarting.lastExit).toBe('exit code 1: Something broke {"x":1}');
      delays.push(Date.parse(restarting.retryAt) - NOW);
    }
    expect(delays).toEqual([10, 20, 40, 40]);
    await waitFor(() => calls.length === 5, 'the fifth start');
    await supervisor.stop(1_000);
  });

  it('hands revocation and takeover over without restarting', async () => {
    for (const [code, exit] of [
      [3, 'revoked'],
      [4, 'taken_over'],
    ] as const) {
      const { supervisor, calls, finals } = harness();
      supervisor.start();
      await waitFor(() => calls.length === 1, 'the spawn');
      calls[0]!.child.exit(code);
      expect(finals).toEqual([exit]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(calls).toHaveLength(1);
      expect(supervisor.running).toBe(false);
    }
  });

  it('does not restart a controller stopped on a configuration error, and shows its reason', async () => {
    const { supervisor, calls, phases, finals } = harness();
    supervisor.start();
    await waitFor(() => calls.length === 1, 'the spawn');
    const child = calls[0]!.child;
    child.say('2026-01-01T00:00:00.000Z WARN The file secret store is in use');
    child.say(
      'switch-agent-controller: /data already belongs to controller c1 on https://switch.example.com, not c2.'
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    child.exit(2);
    expect(phases.at(-1)).toEqual({
      kind: 'error',
      message:
        'The agents controller cannot run as it is set up: /data already belongs to controller c1 on https://switch.example.com, not c2.',
    });
    expect(finals).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toHaveLength(1);
    expect(supervisor.running).toBe(false);
  });

  it('takes the reason from the last line of a usage refusal, not the usage text before it', async () => {
    const { supervisor, calls, phases } = harness();
    supervisor.start();
    await waitFor(() => calls.length === 1, 'the spawn');
    const child = calls[0]!.child;
    child.say('Usage: switch-agent-controller <command> [options]');
    child.say('Log level: SWITCH_CONTROLLER_LOG_LEVEL (debug, info, warn, error; default info).');
    child.say(
      'switch-agent-controller: --controller-id and --server adopt an identity together; pass both.'
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    child.exit(2);
    expect(phases.at(-1)).toEqual({
      kind: 'error',
      message:
        'The agents controller cannot run as it is set up: --controller-id and --server adopt an identity together; pass both.',
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toHaveLength(1);
  });

  it('still restarts on exit code 1, the code for failures that may pass', async () => {
    const { supervisor, calls, phases } = harness();
    supervisor.start();
    await waitFor(() => calls.length === 1, 'the spawn');
    calls[0]!.child.say('switch-agent-controller: fetch failed');
    await new Promise((resolve) => setTimeout(resolve, 5));
    calls[0]!.child.exit(1);
    expect(phases.at(-1)).toMatchObject({
      kind: 'restarting',
      attempt: 1,
      lastExit: 'exit code 1: fetch failed',
    });
    await waitFor(() => calls.length === 2, 'the restart');
    await supervisor.stop(1_000);
  });

  it('reports a launch that cannot be prepared, and spawns nothing', async () => {
    const { supervisor, calls, phases } = harness(async () => {
      throw new Error('The credential for this computer is missing.');
    });
    supervisor.start();
    await waitFor(() => phases.length === 1, 'the phase');
    expect(phases[0]).toEqual({
      kind: 'error',
      message: 'The credential for this computer is missing.',
    });
    expect(calls).toHaveLength(0);
  });

  it('logs each line at the level the controller wrote it, and its bare stderr as errors', async () => {
    const { supervisor, calls, lines } = harness();
    supervisor.start();
    await waitFor(() => calls.length === 1, 'the spawn');
    const child = calls[0]!.child;
    child.say('2026-01-01T00:00:00.000Z INFO Connected to Switch');
    child.say('2026-01-01T00:00:00.000Z WARN Status report failed');
    child.say('switch-agent-controller: boom');
    child.stdout.write('Enrolled as controller x\n');
    await waitFor(() => lines.length === 4, 'four lines');
    expect(lines.map(([level]) => level).sort()).toEqual(['error', 'info', 'info', 'warn']);
    await supervisor.stop(1_000);
  });

  it('stops with SIGTERM, escalates to SIGKILL, and does not restart', async () => {
    const { supervisor, calls } = harness();
    supervisor.start();
    await waitFor(() => calls.length === 1, 'the spawn');
    const child = calls[0]!.child;
    child.exitsOnSigterm = false;
    await supervisor.stop(20);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toHaveLength(1);
  });

  it('waits for a released controller to exit by itself, and says when it does not', async () => {
    const { supervisor, calls } = harness();
    supervisor.start();
    await waitFor(() => calls.length === 1, 'the spawn');
    const exited = supervisor.release(1_000);
    calls[0]!.child.exit(3);
    expect(await exited).toBe(true);

    const second = harness();
    second.supervisor.start();
    await waitFor(() => second.calls.length === 1, 'the spawn');
    expect(await second.supervisor.release(10)).toBe(false);
    expect(second.calls[0]!.child.signals).toEqual([]);
    second.calls[0]!.child.exit(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(second.calls).toHaveLength(1);
  });

  it('reports a spawn failure as an error', async () => {
    const { supervisor, calls, phases } = harness();
    supervisor.start();
    await waitFor(() => calls.length === 1, 'the spawn');
    calls[0]!.child.emit('error', new Error('spawn ENOENT'));
    expect(phases.at(-1)).toEqual({
      kind: 'error',
      message: 'The agents controller could not be started: spawn ENOENT',
    });
  });
});
