import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { main, parseScenarioCases, summaryLine, summaryMarkdown } from './ci-summary.ts';
import { LANES } from './core/env.ts';

const REPORT = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="4">
    <testsuite name="src/core/core.test.ts" tests="1">
        <testcase classname="src/core/core.test.ts" name="configuration &gt; unit" time="0.001">
        </testcase>
    </testsuite>
    <testsuite name="src/provider/provider.e2e.test.ts" tests="1">
        <testcase classname="src/provider/provider.e2e.test.ts" name="provider lane &gt; greet" time="0">
            <skipped/>
        </testcase>
    </testsuite>
    <testsuite name="src/fast/fast.e2e.test.ts" tests="3">
        <testcase classname="src/fast/fast.e2e.test.ts" name="fast lane &gt; addressed-delivery" time="1.25">
        </testcase>
        <testcase classname="src/fast/fast.e2e.test.ts" name="fast lane &gt; operations" time="0.5">
            <failure message="expected 200 to be 404 | &quot;x&quot;&#10;second line" type="AssertionError">stack</failure>
        </testcase>
        <testcase classname="src/fast/fast.e2e.test.ts" name="fast lane &gt; console-chat-roundtrip" time="0">
            <skipped/>
        </testcase>
    </testsuite>
</testsuites>`;

describe('CI run summary', () => {
  it("reads the lane's end-to-end cases, leaving out unit tests and the other lane", () => {
    const cases = parseScenarioCases(REPORT, 'fast');
    expect(cases.map((each) => [each.name, each.status])).toEqual([
      ['fast lane > addressed-delivery', 'pass'],
      ['fast lane > operations', 'fail'],
      ['fast lane > console-chat-roundtrip', 'skip'],
    ]);
    expect(cases[1]!.failure).toBe('expected 200 to be 404 | "x"');
  });

  it('counts each outcome, and says so when there were no scenarios', () => {
    const cases = parseScenarioCases(REPORT, 'fast');
    expect(summaryLine('fast on ephemeral', cases)).toBe(
      'fast on ephemeral: 1 passed, 1 failed, 1 skipped'
    );
    expect(summaryMarkdown('fast on ephemeral', cases)).toContain('expected 200 to be 404 \\|');
    expect(summaryMarkdown('fast on dev', [])).toContain('holds no end-to-end scenarios');
  });
});

describe('CI run summary, as the workflow calls it', () => {
  it('takes every lane, and refuses one that is not', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'e2e-ci-summary-'));
    const report = path.join(dir, 'junit.xml');
    writeFileSync(report, REPORT);
    vi.stubEnv('GITHUB_OUTPUT', '');
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      for (const lane of LANES) {
        expect(() => main([report, lane, `${lane} lane on ephemeral`])).not.toThrow();
      }
      expect(() => main([report, 'nightly', 'title'])).toThrow(/Usage/);
    } finally {
      write.mockRestore();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
