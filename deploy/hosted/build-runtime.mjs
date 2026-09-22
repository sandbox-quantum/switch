#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.length !== 3) {
  throw new Error('Usage: node deploy/hosted/build-runtime.mjs <output-directory>');
}
const repository = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../console/package.json', import.meta.url));
const { build } = require('esbuild');
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const names = ['hosted-bootstrap', 'shared-host-daemon', 'switch-agent-runtime'];
await build({
  absWorkingDir: repository,
  entryPoints: {
    'hosted-bootstrap': 'console/packages/agent-providers/src/host/hosted-bootstrap-cli.ts',
    'shared-host-daemon': 'console/packages/agent-providers/src/host/shared-daemon.ts',
    'switch-agent-runtime': 'console/packages/switch-agent-runtime/src/bin.ts',
  },
  outdir: output,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  tsconfig: 'console/packages/agent-providers/tsconfig.json',
  banner: {
    js: "import { createRequire as createHostedRequire } from 'node:module'; const require = createHostedRequire(import.meta.url);",
  },
  plugins: [
    {
      name: 'headless-runtime-only',
      setup(context) {
        context.onResolve(
          { filter: /^(electron|better-sqlite3|drizzle-orm|@main\/db)(\/|$)/ },
          (args) => ({
            errors: [{ text: `Hosted runtime cannot import desktop dependency: ${args.path}` }],
          })
        );
      },
    },
  ],
  logLevel: 'info',
});

async function smokeMcpRuntime(path) {
  const home = await mkdtemp(resolve(tmpdir(), 'switch-hosted-runtime-smoke-'));
  const child = spawn(process.execPath, [path], {
    cwd: home,
    env: { HOME: home, PATH: process.env.PATH ?? '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const response = new Promise((accept, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Baked MCP runtime did not initialize: ${stderr}`)),
      10_000
    );
    const inspect = () => {
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.id === 1) {
            clearTimeout(timeout);
            if (!message.result)
              reject(new Error(`Baked MCP runtime rejected initialize: ${line}`));
            else accept();
            return;
          }
        } catch {
          // Wait for a complete JSON line.
        }
      }
    };
    child.stdout.on('data', inspect);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Baked MCP runtime exited before initialize (${code ?? signal ?? 'unknown'}): ${stderr}`
        )
      );
    });
  });
  try {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'hosted-build-smoke', version: '1' },
        },
      })}\n`
    );
    await response;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }
    await rm(home, { recursive: true, force: true });
  }
}

await smokeMcpRuntime(resolve(output, 'switch-agent-runtime.mjs'));
const files = {};
for (const name of names) {
  const file = `${name}.mjs`;
  files[file] = createHash('sha256')
    .update(await readFile(resolve(output, file)))
    .digest('hex');
}
await writeFile(
  resolve(output, 'manifest.json'),
  JSON.stringify({ version: 1, nodeMajor: 24, files }, null, 2) + '\n'
);
