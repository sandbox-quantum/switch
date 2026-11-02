import { describe, expect, it } from 'vitest';
import { ProviderRechecks, RechecksNotServing } from './provider-rechecks';

describe('ProviderRechecks', () => {
  it('refuses with its own error while nothing serves it, so a caller can tell that case apart', async () => {
    const rechecks = new ProviderRechecks();
    await expect(rechecks.run()).rejects.toBeInstanceOf(RechecksNotServing);
  });

  it('runs the handler while served, and refuses again once it stops', async () => {
    const rechecks = new ProviderRechecks();
    let runs = 0;
    const stop = rechecks.serve(async () => {
      runs++;
    });
    await rechecks.run();
    expect(runs).toBe(1);
    stop();
    await expect(rechecks.run()).rejects.toBeInstanceOf(RechecksNotServing);
  });
});
