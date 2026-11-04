import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { cloudMachineSchema } from './cloud-agents';

const CORE_FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../../core/tests/switch_core/fixtures/hosted_machines'
);

function coreFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(CORE_FIXTURES, name), 'utf8')) as unknown;
}

const idleSleeping = coreFixture('machine_summary_sleeping.json');

it('parses the idle-sleeping machine summary Core serves', () => {
  expect(cloudMachineSchema.parse(idleSleeping)).toEqual(idleSleeping);
});

it('reads a stop reason it does not know as null, never failing the machine list', () => {
  const parsed = cloudMachineSchema.parse({ ...(idleSleeping as object), stop_reason: 'evicted' });
  expect(parsed.stop_reason).toBeNull();
});

it('reads AI calls with a reset time that is not a time as null', () => {
  const calls = { used: 40, cap: 200, capped: false, resets_at: 'tomorrow' };
  expect(
    cloudMachineSchema.parse({ ...(idleSleeping as object), ai_calls_today: calls }).ai_calls_today
  ).toBeNull();
  const good = { ...calls, resets_at: '2026-10-30T00:00:00+00:00' };
  expect(
    cloudMachineSchema.parse({ ...(idleSleeping as object), ai_calls_today: good }).ai_calls_today
  ).toEqual(good);
});

it('refuses a machine in a state it does not know', () => {
  expect(() =>
    cloudMachineSchema.parse({ ...(idleSleeping as object), state: 'hibernating' })
  ).toThrow();
});

it('reads a Your cloud field out of shape as null, never failing the machine list', () => {
  const parsed = cloudMachineSchema.parse({
    ...(idleSleeping as object),
    room: { used_bytes: 1, total_bytes: 0 },
    awake: { running: 3, max: 15 },
    ai_calls_today: { used: 'lots' },
  });
  expect(parsed.room).toBeNull();
  expect(parsed.ai_calls_today).toBeNull();
  expect(parsed.awake).toEqual({ running: 3, max: 15 });
});

it('reads the Your cloud fields as null from an older server', () => {
  const {
    room: _r,
    awake: _a,
    ai_calls_today: _c,
    ...older
  } = idleSleeping as Record<string, unknown>;
  const parsed = cloudMachineSchema.parse(older);
  expect([parsed.room, parsed.awake, parsed.ai_calls_today]).toEqual([null, null, null]);
});

it('reads the providers to seal again after a repair (V3b), and nothing from an older server', () => {
  const base = idleSleeping as Record<string, unknown>;
  expect(
    cloudMachineSchema.parse({ ...base, reseal_providers: ['claude'] }).reseal_providers
  ).toEqual(['claude']);
  expect(cloudMachineSchema.parse({ ...base, reseal_providers: [] }).reseal_providers).toEqual([]);
  const { reseal_providers: _gone, ...older } = base;
  expect(cloudMachineSchema.parse(older).reseal_providers).toBeUndefined();
  for (const bad of ['claude', [''], [1], Array(17).fill('claude')])
    expect(
      cloudMachineSchema.parse({ ...base, reseal_providers: bad }).reseal_providers
    ).toBeUndefined();
});

it('reads whether Repair my cloud can be pressed (V3b), and nothing from an older server', () => {
  const base = idleSleeping as Record<string, unknown>;
  expect(cloudMachineSchema.parse({ ...base, repair_available: true }).repair_available).toBe(true);
  const { repair_available: _gone, ...older } = base;
  expect(cloudMachineSchema.parse(older).repair_available).toBeUndefined();
  for (const bad of ['yes', 1, null])
    expect(
      cloudMachineSchema.parse({ ...base, repair_available: bad }).repair_available
    ).toBeUndefined();
});
