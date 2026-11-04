import { describe, expect, it } from 'vitest';
import { CumulativeUsage, mergeUsage } from './usage';

const counts = (input: number, output = 0, cacheRead = 0, cacheWrite = 0) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
});

describe('CumulativeUsage', () => {
  it('reports the growth of each model since the last report', () => {
    const usage = new CumulativeUsage();
    expect(usage.advance(new Map([['m', counts(10, 5, 2, 1)]]))).toEqual([
      { model: 'm', ...counts(10, 5, 2, 1) },
    ]);
    expect(
      usage.advance(
        new Map([
          ['m', counts(15, 5, 2, 1)],
          ['n', counts(3)],
        ])
      )
    ).toEqual([
      { model: 'm', ...counts(5) },
      { model: 'n', ...counts(3) },
    ]);
  });

  it('takes a total that went down as a restart and counts it all', () => {
    const usage = new CumulativeUsage();
    usage.advance(new Map([['m', counts(100, 50)]]));
    expect(usage.advance(new Map([['m', counts(7, 60)]]))).toEqual([
      { model: 'm', ...counts(7, 60) },
    ]);
  });

  it('ignores a zeroed report so the next real total is not counted twice', () => {
    const usage = new CumulativeUsage();
    usage.advance(new Map([['m', counts(100)]]));
    expect(usage.advance(new Map([['m', counts(0)]]))).toEqual([]);
    expect(usage.advance(new Map())).toEqual([]);
    expect(usage.advance(new Map([['m', counts(120)]]))).toEqual([{ model: 'm', ...counts(20) }]);
  });

  it('reports nothing for a model that did not move', () => {
    const usage = new CumulativeUsage();
    usage.advance(new Map([['m', counts(10)]]));
    expect(usage.advance(new Map([['m', counts(10)]]))).toEqual([]);
  });
});

describe('mergeUsage', () => {
  it('adds entries for the same model and keeps others apart', () => {
    expect(
      mergeUsage(
        [{ model: 'm', ...counts(1, 1) }],
        [
          { model: 'm', ...counts(2, 0, 3) },
          { model: 'n', ...counts(4) },
        ]
      )
    ).toEqual([
      { model: 'm', ...counts(3, 1, 3) },
      { model: 'n', ...counts(4) },
    ]);
  });
});
