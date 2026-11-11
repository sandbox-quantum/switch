import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('cleans up a pending recorder wait after a real Vitest timeout', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'switch-conformance-timeout-test-'));
  try {
    const sentinel = join(scratch, 'cleanup.log');
    const report = join(scratch, 'report.json');
    const config = join(scratch, 'vitest.config.mjs');
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const require = createRequire(import.meta.url);
    const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
    await writeFile(
      config,
      `export default { test: { include: ['src/testing/fixtures/conformance-timeout.fixture.ts'] } };\n`
    );
    const result = await new Promise<{
      code: number | string | null | undefined;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      execFile(
        process.execPath,
        [
          vitest,
          'run',
          '--root',
          root,
          '--config',
          config,
          '--reporter=json',
          '--outputFile',
          report,
        ],
        {
          cwd: root,
          env: { ...process.env, CONFORMANCE_TIMEOUT_SENTINEL: sentinel },
          timeout: 30000,
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => resolve({ code: error?.code, stdout, stderr })
      );
    });
    expect(result.code, result.stderr || result.stdout).toBe(1);
    const summary = JSON.parse(await readFile(report, 'utf8')) as {
      numFailedTests: number;
      numPassedTests: number;
      testResults: Array<{
        assertionResults: Array<{ title: string; status: string; failureMessages: string[] }>;
      }>;
    };
    expect(summary.numFailedTests).toBe(1);
    expect(summary.numPassedTests).toBe(1);
    const assertions = summary.testResults.flatMap((file) => file.assertionResults);
    const timedOut = assertions.find((assertion) => assertion.title === 'simple-turn');
    expect(timedOut?.status).toBe('failed');
    expect(timedOut?.failureMessages.join('\n')).toMatch(/timed out/i);
    expect(
      assertions.find((assertion) => assertion.title === 'file-write-full-access')?.status
    ).toBe('passed');
    expect(await readFile(sentinel, 'utf8')).toBe('unsubscribe:1\nstop:1\nunsubscribe:2\nstop:2\n');
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(
      /Unhandled Errors|Unhandled Rejection/i
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 45000);
