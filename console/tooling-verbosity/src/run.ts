/**
 * Run a scenario several times and record what the agent posted.
 *
 *     ../node_modules/.bin/tsx --import ./src/md-loader.mjs src/run.ts \
 *       --scenario design-question --runs 5 --label baseline [--source <console dir>]
 *
 * Writes `results/<label>/<scenario>/run-<n>.json` and a `summary.md` beside
 * them. See README.md.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { measure, summarise } from './metrics';
import { SCENARIOS } from './scenarios';
import { runOnce, type RunResult } from './session';

const here = dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  options: {
    scenario: { type: 'string', multiple: true },
    runs: { type: 'string', default: '5' },
    label: { type: 'string', default: 'run' },
    source: { type: 'string', default: resolve(here, '../..') },
    model: { type: 'string' },
    concurrency: { type: 'string', default: '3' },
    timeout: { type: 'string', default: '900' },
    'skill-file': { type: 'string' },
    'reminder-file': { type: 'string' },
  },
});

const source = resolve(values.source!);
const repo = execFileSync('git', ['-C', source, 'rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();
const names = values.scenario ?? Object.keys(SCENARIOS);
const runs = Number(values.runs);
const concurrency = Number(values.concurrency);

/** The operation catalog of the tree under test, as its server would serve it. */
function operations(): Record<string, unknown> {
  const out = execFileSync(
    'uv',
    ['run', '--python', '3.13', '-q', 'python', join(here, '../scripts/dump_operations.py')],
    { cwd: join(repo, 'core'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  return (JSON.parse(out) as { operations: Record<string, unknown> }).operations;
}

/** A checkout of `commit` for the agent to work in, one per run so runs cannot disturb each other. */
function checkout(commit: string, tag: string): { dir: string; remove: () => void } {
  const dir = join(tmpdir(), `switch-verbosity-${tag}-${process.pid}`);
  if (existsSync(dir)) execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', dir]);
  execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', '--quiet', dir, commit]);
  return {
    dir,
    remove: () => execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', dir]),
  };
}

async function pool<T>(count: number, limit: number, task: (index: number) => Promise<T>) {
  const results: T[] = new Array(count);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, count) }, async () => {
      while (next < count) {
        const index = next++;
        results[index] = await task(index);
      }
    })
  );
  return results;
}

const catalog = operations();
const overrides = {
  ...(values['skill-file'] ? { skill: readFileSync(values['skill-file'], 'utf8') } : {}),
  ...(values['reminder-file']
    ? { reminder: readFileSync(values['reminder-file'], 'utf8').trim() }
    : {}),
};
for (const name of names) {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`No scenario named ${name}.`);
  const out = join(here, '../results', values.label!, name);
  await mkdir(out, { recursive: true });
  const results = await pool(runs, concurrency, async (index) => {
    const tree = checkout(scenario.repoCommit, `${name}-${index}`);
    try {
      process.stderr.write(`${name} #${index + 1}: running\n`);
      const result: RunResult = await runOnce({
        source,
        scenario,
        operations: catalog,
        cwd: tree.dir,
        model: values.model ?? null,
        timeoutMs: Number(values.timeout) * 1000,
        overrides,
      });
      const record = { scenario: name, run: index + 1, ...result, metrics: measure(result.posts) };
      await writeFile(join(out, `run-${index + 1}.json`), JSON.stringify(record, null, 2));
      process.stderr.write(
        `${name} #${index + 1}: ${result.outcome}, ${record.metrics.posts} posts, ${record.metrics.words} words\n`
      );
      return record;
    } finally {
      tree.remove();
    }
  });
  await writeFile(join(out, 'summary.md'), summarise(scenario, values.label!, results));
  process.stderr.write(`${name}: wrote ${out}\n`);
}

// The SDK can leave handles open after its sessions stop.
process.exit(0);
