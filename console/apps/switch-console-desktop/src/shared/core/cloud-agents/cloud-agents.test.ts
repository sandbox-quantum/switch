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

it('refuses a machine in a state it does not know', () => {
  expect(() =>
    cloudMachineSchema.parse({ ...(idleSleeping as object), state: 'hibernating' })
  ).toThrow();
});
