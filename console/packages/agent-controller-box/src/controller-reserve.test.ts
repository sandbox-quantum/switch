import { boxCap } from '@switch-console/agent-providers-box';
import { describe, expect, it } from 'vitest';
import {
  controllerReserveFromEnv,
  DEFAULT_CONTROLLER_RESERVE_BYTES,
  valveLimits,
} from './controller-reserve';

const MIB = 1024 * 1024;
const POD = 6 * 1024 * MIB;

function run(env: NodeJS.ProcessEnv, split: boolean, podLimit: number | null = POD) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const reserve = controllerReserveFromEnv(env, {
    split,
    podLimit,
    log: {
      error: (message: string) => void errors.push(message),
      warn: (message: string) => void warnings.push(message),
    },
  });
  return { reserve, errors, warnings };
}

describe('controllerReserveFromEnv (decision v4)', () => {
  it('on a split box with none set, keeps 256 MiB and says so once, as an error', () => {
    const { reserve, errors, warnings } = run({}, true);
    expect(reserve).toBe(DEFAULT_CONTROLLER_RESERVE_BYTES);
    expect(reserve).toBe(256 * MIB);
    expect(errors).toHaveLength(1);
    expect(warnings).toHaveLength(0);
  });

  it.each(['lots', '-5', '0', '1.5', '256MiB', String(POD / 2 + 1)])(
    'on a split box with a value that is not valid (%s), keeps 256 MiB with one error',
    (value) => {
      const { reserve, errors } = run({ SWITCH_CONTROLLER_RESERVE_BYTES: value }, true);
      expect(reserve).toBe(256 * MIB);
      expect(errors).toHaveLength(1);
    }
  );

  it('on an unsplit box with none set, keeps none and says nothing: nothing changes', () => {
    const { reserve, errors, warnings } = run({}, false);
    expect(reserve).toBe(0);
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('on an unsplit box with a value that is not valid, keeps none, with one warning', () => {
    const { reserve, errors, warnings } = run({ SWITCH_CONTROLLER_RESERVE_BYTES: 'lots' }, false);
    expect(reserve).toBe(0);
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });

  it('takes a valid value on either kind of box, up to half the box limit', () => {
    for (const split of [true, false]) {
      expect(run({ SWITCH_CONTROLLER_RESERVE_BYTES: String(300 * MIB) }, split).reserve).toBe(
        300 * MIB
      );
      expect(run({ SWITCH_CONTROLLER_RESERVE_BYTES: String(POD / 2) }, split).reserve).toBe(
        POD / 2
      );
    }
  });

  it('keeps nothing without a box limit, since there is nothing to reserve under', () => {
    const { reserve, errors } = run(
      { SWITCH_CONTROLLER_RESERVE_BYTES: String(300 * MIB) },
      true,
      null
    );
    expect(reserve).toBe(0);
    expect(errors).toHaveLength(0);
  });

  it('never keeps more than half a small box limit, even as the default', () => {
    expect(run({}, true, 400 * MIB).reserve).toBe(200 * MIB);
  });
});

describe('valveLimits: the cap stays on the box limit, the memory lines move down', () => {
  it('keeps the cap where it was, and lowers only the line limit by the reserve', () => {
    const quiet = { warn: () => {} };
    const without = valveLimits(POD, 0);
    const withReserve = valveLimits(POD, 256 * MIB);
    expect(withReserve?.capLimit).toBe(POD);
    expect(withReserve?.lineLimit).toBe(POD - 256 * MIB);
    expect(without?.lineLimit).toBe(POD);
    // The cap the valve is given doesn't move with the reserve (12 on a 6 GiB box).
    expect(boxCap(withReserve!.capLimit, {}, quiet).cap).toBe(boxCap(POD, {}, quiet).cap);
    expect(boxCap(withReserve!.capLimit, {}, quiet).cap).toBe(12);
  });

  it('is off without a box limit', () => {
    expect(valveLimits(null, 256 * MIB)).toBeNull();
  });
});
