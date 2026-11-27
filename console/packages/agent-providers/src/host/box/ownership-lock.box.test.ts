import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { withOwnershipLock } from '../ownership-lock';
import { boxTicketJudge } from './owner-records';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function rootWith(
  ticketPid: number,
  ticket: object
): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ownership-box-'));
  roots.push(root);
  await mkdir(join(root, 'ownership'), { recursive: true });
  const path = join(root, 'ownership', `${ticketPid}-00000000-0000-4000-8000-000000000000.json`);
  await writeFile(path, JSON.stringify(ticket));
  return { root, path };
}

it('passes over a ticket left by an earlier process that had this id', async () => {
  // A container restarting gives the controller the same low id as the one
  // killed in the middle of an election, so its own id names the old ticket.
  const { root } = await rootWith(process.pid, { choosing: false, ticket: 1 });
  const started = performance.now();
  await expect(withOwnershipLock(root, async () => 'taken', boxTicketJudge)).resolves.toBe('taken');
  expect(performance.now() - started).toBeLessThan(5000);
});

it('without the box judge (Console), the same ticket still counts', async () => {
  const { root } = await rootWith(process.pid, { choosing: false, ticket: 1 });
  await expect(withOwnershipLock(root, async () => 'taken')).rejects.toThrow();
}, 30_000);

it('still waits for a ticket another live process holds', async () => {
  const { root } = await rootWith(process.ppid, { choosing: false, ticket: 1 });
  await expect(withOwnershipLock(root, async () => 'taken', boxTicketJudge)).rejects.toThrow(
    'FENCING_REQUIRED'
  );
}, 30_000);

it.skipIf(process.platform === 'win32')(
  'passes over a ticket left by an earlier process whose id a later one holds now',
  async () => {
    const { root, path } = await rootWith(process.ppid, { choosing: true, ticket: 0 });
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 3600 * 1000);
    await utimes(path, fourDaysAgo, fourDaysAgo);
    const ran = await Promise.race([
      withOwnershipLock(root, async () => true, boxTicketJudge),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    expect(ran).toBe(true);
  }
);
