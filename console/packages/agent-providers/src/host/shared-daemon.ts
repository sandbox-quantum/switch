import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sessionSchema } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import { ownProcessGroup } from './process-fence';
import { adapterFor, startSchema } from './server';
import { runSharedHost, SharedHostLeaseExpiredError } from './shared-host';

const [root, configPath] = process.argv.slice(2);
const agentApiUrl = process.env.SWITCH_API_ENDPOINT;
const token = process.env.SWITCH_API_TOKEN;
if (!root || !configPath || !agentApiUrl || !token)
  throw new Error(
    'Shared SDK host requires a state directory, a configuration file, SWITCH_API_ENDPOINT and SWITCH_API_TOKEN.'
  );
const config = z
  .strictObject({ session: sessionSchema, start: startSchema })
  .parse(JSON.parse(await readFile(configPath, 'utf8')));
if (config.session.provider !== config.start.provider)
  throw new Error('Shared SDK host provider mismatch.');
if (process.platform !== 'win32' && (await ownProcessGroup()) === null) {
  const child = spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    stdio: 'inherit',
    env: process.env,
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => child.kill(signal));
  child.on('error', (error) => {
    throw error;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
} else {
  const stop = new AbortController();
  process.on('SIGTERM', () => stop.abort());
  process.on('SIGINT', () => stop.abort());
  while (!stop.signal.aborted) {
    try {
      await runSharedHost(
        {
          root: resolve(root),
          agentApiUrl,
          token,
          session: config.session,
          input: config.start.input,
        },
        adapterFor(config.start.provider),
        stop.signal
      );
      break;
    } catch (error) {
      if (stop.signal.aborted) break;
      if (!(error instanceof SharedHostLeaseExpiredError)) throw error;
      console.warn('Shared host lease expired. Execution stopped; reconnecting with saved state.');
      try {
        await delay(1000, undefined, { signal: stop.signal });
      } catch (error) {
        if (!stop.signal.aborted) throw error;
      }
    }
  }
}
