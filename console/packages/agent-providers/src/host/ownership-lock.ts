import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

export const hostedMachineIdentitySchema = z.strictObject({
  instanceId: z.string().regex(/^i-[0-9a-f]{8,17}$/),
  bootId: z.string().uuid(),
  assignmentGeneration: z.number().int().positive(),
});
export type HostedMachineIdentity = z.infer<typeof hostedMachineIdentitySchema>;

const MACHINE_ENVIRONMENT = {
  instanceId: 'SWITCH_HOST_INSTANCE_ID',
  bootId: 'SWITCH_HOST_BOOT_ID',
  assignmentGeneration: 'SWITCH_HOST_ASSIGNMENT_GENERATION',
} as const;

export function currentHostedMachineIdentity(
  environment: NodeJS.ProcessEnv = process.env
): HostedMachineIdentity | undefined {
  const values = Object.values(MACHINE_ENVIRONMENT).map((name) => environment[name]);
  if (values.every((value) => value === undefined)) return undefined;
  if (values.some((value) => value === undefined))
    throw new Error('Hosted machine identity environment is incomplete.');
  const result = hostedMachineIdentitySchema.safeParse({
    instanceId: environment[MACHINE_ENVIRONMENT.instanceId],
    bootId: environment[MACHINE_ENVIRONMENT.bootId],
    assignmentGeneration: Number(environment[MACHINE_ENVIRONMENT.assignmentGeneration]),
  });
  if (!result.success) throw new Error('Hosted machine identity environment is invalid.');
  return result.data;
}

export function ownerMachineIdentitySchema() {
  return hostedMachineIdentitySchema.optional();
}

export function ownershipRecord<T extends object>(
  value: T
): T & {
  machine?: HostedMachineIdentity;
} {
  const machine = currentHostedMachineIdentity();
  return machine ? { ...value, machine } : value;
}

export function assertCurrentOwnershipMachine(machine: HostedMachineIdentity | undefined): void {
  const current = currentHostedMachineIdentity();
  if (!current && !machine) return;
  if (!current || !machine || !isDeepStrictEqual(machine, current))
    throw new Error('FENCING_REQUIRED: ownership record belongs to another machine boot.');
}

const ticketSchema = z.strictObject({
  choosing: z.boolean(),
  ticket: z.number().int().nonnegative(),
  machine: ownerMachineIdentitySchema(),
});
type Ticket = z.infer<typeof ticketSchema>;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function save(path: string, value: unknown, replace: boolean): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    if (replace) await rename(temporary, path);
    else await link(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

/** Bakery election: each contender writes only its own ticket, so reclamation needs no lock. */
export async function withOwnershipLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const directory = join(root, 'ownership');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const id = `${process.pid}-${randomUUID()}.json`;
  const path = join(directory, id);
  const entries = async (): Promise<Array<{ id: string; value: Ticket }>> => {
    const result = [];
    for (const name of await readdir(directory)) {
      if (!/^\d+-[a-f0-9-]+\.json$/.test(name)) continue;
      const pid = Number(name.split('-')[0]);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid ownership ticket PID.');
      try {
        const living = alive(pid);
        if (!living && !currentHostedMachineIdentity()) {
          try {
            const stale = JSON.parse(await readFile(join(directory, name), 'utf8'));
            if (stale && typeof stale === 'object' && 'machine' in stale)
              assertCurrentOwnershipMachine(hostedMachineIdentitySchema.parse(stale.machine));
          } catch (error) {
            if (error instanceof Error && error.message.startsWith('FENCING_REQUIRED:'))
              throw error;
          }
          continue;
        }
        const value = ticketSchema.parse(JSON.parse(await readFile(join(directory, name), 'utf8')));
        assertCurrentOwnershipMachine(value.machine);
        if (!living) continue;
        result.push({
          id: name,
          value,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return result;
  };
  await save(path, ownershipRecord({ choosing: true, ticket: 0 }), false);
  try {
    const ticket = Math.max(0, ...(await entries()).map((entry) => entry.value.ticket)) + 1;
    if (!Number.isSafeInteger(ticket)) throw new Error('Ownership ticket space exhausted.');
    await save(path, ownershipRecord({ choosing: false, ticket }), true);
    const deadline = performance.now() + 15000;
    while (
      (await entries()).some(
        (entry) =>
          entry.id !== id &&
          (entry.value.choosing ||
            entry.value.ticket < ticket ||
            (entry.value.ticket === ticket && entry.id < id))
      )
    ) {
      if (performance.now() >= deadline)
        throw new Error('FENCING_REQUIRED: another live host is acquiring ownership.');
      await delay(25);
    }
    return await action();
  } finally {
    await unlink(path);
  }
}

export async function replaceOwner(path: string, value: unknown): Promise<void> {
  await save(path, value, true);
}

export async function releaseOwner(root: string, path: string, owner: unknown): Promise<void> {
  await withOwnershipLock(root, async () => {
    try {
      const current = JSON.parse(await readFile(path, 'utf8'));
      if (JSON.stringify(current) === JSON.stringify(owner)) await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  });
}
