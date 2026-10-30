import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../log';
import type { DecisionRequestFrame, DecisionStatus } from '../schemas';
import { decisionStatusSchema } from '../schemas';
import {
  FakeDownloads,
  FakeLauncher,
  testCatalogue,
  testDecisionRuntime,
} from '../testing/fake-decision';
import { decisionLayout, writeLocalSetting } from './local-setting';
import { type DecisionRuntime, type DecisionRuntimeDeps, MAX_IN_FLIGHT } from './runtime';

const SECRET_TEXT = 'the-launch-codes-are-in-the-blue-folder';

async function waitFor(condition: () => boolean, what: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await delay(5);
  }
}

function request(overrides: Partial<DecisionRequestFrame> = {}): DecisionRequestFrame {
  return {
    request_id: 'request-1',
    kind: 'llamacpp',
    model: 'test-model',
    payload: {
      messages: [{ role: 'user', content: SECRET_TEXT }],
      max_tokens: 1,
      temperature: 0,
      logprobs: true,
      top_logprobs: 20,
      chat_template_kwargs: { enable_thinking: false },
    },
    deadline_ms: 5_000,
    ...overrides,
  };
}

let dir: string;
let launcher: FakeLauncher;
let downloads: FakeDownloads;
let logged: string[];
let changes: number;
let runtimes: DecisionRuntime[];

const recordingLog: Logger = {
  debug: (message, fields) => void logged.push(`${message} ${JSON.stringify(fields ?? {})}`),
  info: (message, fields) => void logged.push(`${message} ${JSON.stringify(fields ?? {})}`),
  warn: (message, fields) => void logged.push(`${message} ${JSON.stringify(fields ?? {})}`),
  error: (message, fields) => void logged.push(`${message} ${JSON.stringify(fields ?? {})}`),
};

async function started(overrides: Partial<DecisionRuntimeDeps> = {}): Promise<DecisionRuntime> {
  const runtime = testDecisionRuntime(dir, {
    fetch: downloads.fetch,
    launch: launcher.launch,
    log: recordingLog,
    onChange: () => void changes++,
    ...overrides,
  });
  runtimes.push(runtime);
  await runtime.start();
  return runtime;
}

function status(runtime: DecisionRuntime): DecisionStatus {
  const current = runtime.status();
  expect(decisionStatusSchema.safeParse(current).success).toBe(true);
  return current;
}

async function running(runtime: DecisionRuntime, revision = 1): Promise<void> {
  runtime.reconcile({ revision, model: 'test-model' });
  await waitFor(() => runtime.status().state === 'running', 'the model running');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-runtime-'));
  launcher = new FakeLauncher();
  downloads = new FakeDownloads(testCatalogue().files);
  logged = [];
  changes = 0;
  runtimes = [];
});

afterEach(async () => {
  for (const runtime of runtimes) await runtime.close();
  await launcher.stopAll();
  rmSync(dir, { recursive: true, force: true });
});

describe('DecisionRuntime', () => {
  it('reports the hardware and what it offers, off while nothing is assigned', async () => {
    const runtime = await started();
    expect(status(runtime)).toMatchObject({
      hardware: { accelerator: 'apple_silicon', gpu_name: 'Apple M4 Pro' },
      offered: [{ model: 'test-model', runtime: 'llamacpp-metal', speed: 'fast' }],
      state: 'off',
      model: null,
      applied_revision: null,
      restarts_10m: 0,
    });
    expect(status(runtime).reason).toBeUndefined();
    expect(launcher.servers).toHaveLength(0);
  });

  it('downloads, verifies, starts the model server on Metal, warms it, and reports running', async () => {
    const runtime = await started();
    const states: string[] = [];
    const seen = setInterval(() => {
      const state = runtime.status().state;
      if (states.at(-1) !== state) states.push(state);
    }, 1);
    runtime.reconcile({ revision: 3, model: 'test-model' });
    await waitFor(() => runtime.status().state === 'running', 'the model running');
    clearInterval(seen);
    expect(states[0]).toBe('downloading');
    expect(states).toContain('starting');
    expect(status(runtime)).toMatchObject({
      state: 'running',
      model: 'test-model',
      applied_revision: 3,
    });

    const layout = decisionLayout(dir);
    const { model } = testCatalogue();
    expect(readdirSync(layout.models)).toEqual([`${model.file.sha256}.gguf`]);
    expect(readdirSync(layout.runtime)).toEqual(['b1-llamacpp-metal']);
    const server = launcher.last!;
    expect(server.spec).toEqual({
      binary: join(layout.runtime, 'b1-llamacpp-metal', 'llama-b1', 'llama-server'),
      libraryDirs: [join(layout.runtime, 'b1-llamacpp-metal', 'llama-b1')],
      modelFile: join(layout.models, `${model.file.sha256}.gguf`),
      contextSize: 16384,
      parallel: 4,
      gpuLayers: 99,
      threads: null,
    });
    // The warm-up decision, with this launch's key.
    expect(server.completions).toHaveLength(1);
    expect(server.completions[0]!.authorization).toBe(`Bearer ${server.apiKey}`);
    expect(changes).toBeGreaterThan(0);
  });

  it('reports progress while downloading', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const files = testCatalogue().files;
    const slow = new FakeDownloads(files);
    const runtime = await started({
      fetch: async (input, init) => {
        if (String(input).endsWith('.gguf')) await gate;
        return slow.fetch(input, init);
      },
    });
    runtime.reconcile({ revision: 1, model: 'test-model' });
    await waitFor(
      () => (runtime.status().progress?.done_bytes ?? 0) === 20_000,
      'the archive downloaded'
    );
    expect(status(runtime)).toMatchObject({
      state: 'downloading',
      progress: { done_bytes: 20_000, total_bytes: 220_000 },
    });
    release();
    await waitFor(() => runtime.status().state === 'running', 'the model running');
    expect(status(runtime).progress).toBeUndefined();
  });

  it('forwards a decision’s payload as it came, with the key, and returns the server’s answer', async () => {
    const runtime = await started();
    await running(runtime);
    const answer = await runtime.decide(request());
    expect(answer).toMatchObject({ type: 'decision.result', request_id: 'request-1', ok: true });
    if (!answer.ok) throw new Error('expected an answer');
    expect(answer.body).toEqual(launcher.last!.answer.body);
    expect(answer.model_ms).toBeGreaterThanOrEqual(0);
    const forwarded = launcher.last!.completions.at(-1)!;
    expect(forwarded.body).toEqual(request().payload);
    expect(forwarded.authorization).toBe(`Bearer ${launcher.last!.apiKey}`);
    expect(status(runtime).last_decision_ms).toBe(answer.model_ms);
  });

  it('never logs a decision’s payload or the model server’s answer', async () => {
    const runtime = await started();
    await running(runtime);
    launcher.last!.answer = { ...launcher.last!.answer, body: { secret: SECRET_TEXT } };
    await runtime.decide(request());
    launcher.last!.answer = { status: 500, body: { error: SECRET_TEXT }, delayMs: 0 };
    await runtime.decide(request({ request_id: 'request-2' }));
    expect(logged.some((line) => line.includes('request-1'))).toBe(true);
    expect(logged.join('\n')).not.toContain(SECRET_TEXT);
  });

  it(`answers busy beyond ${MAX_IN_FLIGHT} decisions at once`, async () => {
    const runtime = await started();
    await running(runtime);
    launcher.last!.answer = { ...launcher.last!.answer, delayMs: 300 };
    const answers = await Promise.all(
      Array.from({ length: MAX_IN_FLIGHT + 1 }, (_, i) =>
        runtime.decide(request({ request_id: `request-${i}` }))
      )
    );
    expect(answers.filter((answer) => answer.ok)).toHaveLength(MAX_IN_FLIGHT);
    expect(answers.at(-1)).toMatchObject({ ok: false, error: { code: 'busy' } });
    // Freed once answered.
    launcher.last!.answer = { ...launcher.last!.answer, delayMs: 0 };
    expect(await runtime.decide(request())).toMatchObject({ ok: true });
  });

  it('answers deadline when the model server is too slow, or the deadline had already passed', async () => {
    const runtime = await started();
    await running(runtime);
    launcher.last!.answer = { ...launcher.last!.answer, delayMs: 500 };
    expect(await runtime.decide(request({ deadline_ms: 50 }))).toMatchObject({
      ok: false,
      error: { code: 'deadline' },
    });
    expect(await runtime.decide(request({ deadline_ms: 0 }))).toMatchObject({
      ok: false,
      error: { code: 'deadline' },
    });
  });

  it('answers not_running while off, for another model, or another kind', async () => {
    const runtime = await started();
    expect(await runtime.decide(request())).toMatchObject({
      ok: false,
      error: { code: 'not_running' },
    });
    await running(runtime);
    expect(await runtime.decide(request({ model: 'another' }))).toMatchObject({
      ok: false,
      error: { code: 'not_running' },
    });
    expect(await runtime.decide(request({ kind: 'systemone' }))).toMatchObject({
      ok: false,
      error: { code: 'not_running' },
    });
  });

  it('answers model_server_error when the model server refuses', async () => {
    const runtime = await started();
    await running(runtime);
    launcher.last!.answer = { status: 500, body: { error: 'boom' }, delayMs: 0 };
    expect(await runtime.decide(request())).toMatchObject({
      ok: false,
      error: { code: 'model_server_error', message: 'The model server answered 500.' },
    });
  });

  it('waits on /health while the model loads', async () => {
    launcher.configure = (server) => {
      server.loading = true;
    };
    const runtime = await started();
    runtime.reconcile({ revision: 1, model: 'test-model' });
    await waitFor(() => launcher.servers.length === 1, 'the launch');
    await delay(50);
    expect(runtime.status().state).toBe('starting');
    launcher.last!.loading = false;
    await waitFor(() => runtime.status().state === 'running', 'the model running');
  });

  it('starts a crashed model server again, and leaves it failed on the third crash in ten minutes', async () => {
    const runtime = await started();
    await running(runtime);
    await launcher.last!.crash();
    await waitFor(() => launcher.servers.length === 2, 'the restart');
    await waitFor(() => runtime.status().state === 'running', 'running again');
    expect(status(runtime).restarts_10m).toBe(1);
    await launcher.last!.crash();
    await waitFor(() => launcher.servers.length === 3, 'the second restart');
    await waitFor(() => runtime.status().state === 'running', 'running again');
    await launcher.last!.crash();
    await waitFor(() => runtime.status().state === 'failed', 'failed');
    expect(status(runtime)).toMatchObject({
      state: 'failed',
      reason: 'model_server_crashed',
      restarts_10m: 3,
      model: 'test-model',
    });
    await delay(100);
    expect(launcher.servers).toHaveLength(3);

    // The same revision again changes nothing; the next one tries again.
    runtime.reconcile({ revision: 1, model: 'test-model' });
    await delay(50);
    expect(launcher.servers).toHaveLength(3);
    runtime.reconcile({ revision: 2, model: 'test-model' });
    await waitFor(() => runtime.status().state === 'running', 'running at the new revision');
    expect(status(runtime).applied_revision).toBe(2);
  });

  it('says out_of_memory when the model server ran out', async () => {
    const runtime = await started({ timing: { ...fastTiming(), crashLimit: 1 } });
    await running(runtime);
    await launcher.last!.crash({ outOfMemory: true });
    await waitFor(() => runtime.status().state === 'failed', 'failed');
    expect(status(runtime).reason).toBe('out_of_memory');
  });

  it('stops the model server when the assignment stops naming a model, and keeps the weights', async () => {
    const runtime = await started();
    await running(runtime);
    const server = launcher.last!;
    runtime.reconcile(null);
    await waitFor(() => server.stopped, 'the server stopped');
    expect(status(runtime)).toMatchObject({ state: 'off', model: null, applied_revision: null });
    expect(readdirSync(decisionLayout(dir).models)).toHaveLength(1);

    downloads.requests.length = 0;
    await running(runtime, 2);
    expect(downloads.requests).toEqual([]);
  });

  it('takes a new revision of the same model without restarting it', async () => {
    const runtime = await started();
    await running(runtime);
    runtime.reconcile({ revision: 5, model: 'test-model' });
    await waitFor(() => runtime.status().applied_revision === 5, 'the revision applied');
    expect(launcher.servers).toHaveLength(1);
  });

  it('is off, turned off on the machine, under SWITCH_CONTROLLER_DECISION_MODEL=off or --no-decision-model', async () => {
    const runtime = await started({ override: 'off' });
    runtime.reconcile({ revision: 1, model: 'test-model' });
    await runtime.settledChanges();
    expect(status(runtime)).toMatchObject({
      state: 'off',
      reason: 'turned_off_on_machine',
      applied_revision: 1,
    });
    expect(launcher.servers).toHaveLength(0);
    expect(downloads.requests).toEqual([]);
  });

  it('follows the owner’s switch in the data directory, and an override of on ignores it', async () => {
    const layout = decisionLayout(dir);
    await writeLocalSetting(layout, false);
    const runtime = await started();
    runtime.reconcile({ revision: 1, model: 'test-model' });
    await runtime.settledChanges();
    expect(status(runtime)).toMatchObject({ state: 'off', reason: 'turned_off_on_machine' });

    await writeLocalSetting(layout, true);
    await runtime.refreshSetting();
    await waitFor(() => runtime.status().state === 'running', 'running once allowed');

    const server = launcher.last!;
    await writeLocalSetting(layout, false);
    await runtime.refreshSetting();
    await waitFor(() => server.stopped, 'the server stopped');
    expect(status(runtime)).toMatchObject({ state: 'off', reason: 'turned_off_on_machine' });

    const overridden = await started({ override: 'on' });
    expect(overridden.status().reason).toBeUndefined();
  });

  it('removes the downloaded model, stopping the model server first', async () => {
    const runtime = await started();
    await running(runtime);
    const server = launcher.last!;
    runtime.reconcile(null);
    await runtime.removeModel();
    expect(server.stopped).toBe(true);
    const layout = decisionLayout(dir);
    expect(existsSync(layout.models)).toBe(false);
    expect(existsSync(layout.runtime)).toBe(false);
    expect(status(runtime).state).toBe('off');
  });

  it('removes it while it is served, and downloads it again for an assignment that still names it', async () => {
    const runtime = await started();
    await running(runtime);
    const first = launcher.last!;
    downloads.requests.length = 0;
    await runtime.removeModel();
    expect(first.stopped).toBe(true);
    await waitFor(() => launcher.servers.length === 2, 'started again');
    await waitFor(() => runtime.status().state === 'running', 'running again');
    expect(downloads.requests.map((entry) => entry.url).sort()).toEqual([
      'https://builds.example.org/llama-test.tar.gz',
      'https://models.example.org/test-model.gguf',
    ]);
  });

  it('fails with not_enough_disk and the size needed, and goes on once there is room', async () => {
    let free = 1024;
    const runtime = await started({ diskFree: async () => free });
    runtime.reconcile({ revision: 1, model: 'test-model' });
    await waitFor(() => runtime.status().state === 'failed', 'failed');
    expect(status(runtime)).toMatchObject({ reason: 'not_enough_disk' });
    expect(status(runtime).detail).toMatch(
      /^Needs 0\.5 GB of free disk space .*; 0\.0 GB is free\.$/
    );
    expect(downloads.requests).toEqual([]);
    free = 100 * 1024 ** 3;
    await waitFor(() => runtime.status().state === 'running', 'running once there is room');
  });

  it('fails with checksum_mismatch, deletes the download, and waits for the next revision', async () => {
    downloads.corrupt.add('https://models.example.org/test-model.gguf');
    const runtime = await started();
    runtime.reconcile({ revision: 1, model: 'test-model' });
    await waitFor(() => runtime.status().state === 'failed', 'failed');
    expect(status(runtime)).toMatchObject({ reason: 'checksum_mismatch', applied_revision: 1 });
    expect(readdirSync(decisionLayout(dir).models)).toEqual([]);
    const asked = downloads.requests.length;
    await delay(100);
    expect(downloads.requests).toHaveLength(asked);

    downloads.corrupt.clear();
    runtime.reconcile({ revision: 2, model: 'test-model' });
    await waitFor(() => runtime.status().state === 'running', 'running at the next revision');
  });

  it('fails with download_failed when the download breaks, and resumes it after a wait', async () => {
    downloads.cutAfter.set('https://models.example.org/test-model.gguf', 50_000);
    const states: string[] = [];
    const runtime = await started({
      onChange: () => void states.push(runtime.status().state),
    });
    runtime.reconcile({ revision: 1, model: 'test-model' });
    await waitFor(() => runtime.status().state === 'running', 'running after the retry');
    expect(states).toContain('failed');
    expect(downloads.requests.at(-1)).toEqual({
      url: 'https://models.example.org/test-model.gguf',
      range: 'bytes=50000-',
    });
  });

  it('fails with unsupported_hardware where the model has no build', async () => {
    const runtime = await started({ arch: 'x64', run: async () => '0\n' });
    expect(status(runtime).offered).toEqual([]);
    runtime.reconcile({ revision: 1, model: 'test-model' });
    await runtime.settledChanges();
    expect(status(runtime)).toMatchObject({ state: 'failed', reason: 'unsupported_hardware' });
    runtime.reconcile({ revision: 2, model: 'unknown-model' });
    await runtime.settledChanges();
    expect(status(runtime).detail).toContain('does not know the model unknown-model');
  });

  it('fails when the model server cannot be started at all', async () => {
    launcher.failWith = new Error('spawn EACCES');
    const runtime = await started();
    runtime.reconcile({ revision: 1, model: 'test-model' });
    await waitFor(() => runtime.status().state === 'failed', 'failed');
    expect(status(runtime)).toMatchObject({ reason: 'model_server_crashed' });
    expect(status(runtime).detail).toContain('spawn EACCES');
  });

  it('runs the CPU build on Linux with its threads', async () => {
    const runtime = await started({ platform: 'linux', arch: 'x64', run: async () => '' });
    expect(status(runtime)).toMatchObject({
      hardware: { accelerator: 'cpu' },
      offered: [{ runtime: 'llamacpp-cpu', speed: 'slow' }],
    });
    await running(runtime);
    expect(launcher.last!.spec).toMatchObject({ gpuLayers: 0, threads: 4 });
    expect(readdirSync(decisionLayout(dir).runtime)).toEqual(['b1-llamacpp-cpu']);
  });

  it('stops the model server when closed', async () => {
    const runtime = await started();
    await running(runtime);
    await runtime.close();
    expect(launcher.last!.stopped).toBe(true);
  });

  it('keeps a partial download between runs and resumes it', async () => {
    const layout = decisionLayout(dir);
    const { model, files } = testCatalogue();
    mkdirSync(layout.models, { recursive: true });
    writeFileSync(
      join(layout.models, `${model.file.sha256}.part`),
      files.get(model.file.url)!.subarray(0, 1234)
    );
    const runtime = await started();
    await running(runtime);
    expect(downloads.requests).toContainEqual({ url: model.file.url, range: 'bytes=1234-' });
  });
});

function fastTiming() {
  return {
    healthTimeoutMs: 5_000,
    healthIntervalMs: 10,
    crashBackoffMs: [10, 20, 40],
    crashLimit: 3,
    crashWindowMs: 10 * 60 * 1000,
    downloadRetryMs: 20,
    downloadRetryMaxMs: 80,
    diskRetryMs: 20,
    stallTimeoutMs: 2_000,
  };
}
