import { expect, it, vi } from 'vitest';
import { providerUsageController } from './controller';

const usage = vi.hoisted(() => ({ getSnapshots: vi.fn(), refresh: vi.fn(), setActive: vi.fn() }));
vi.mock('./instance', () => ({ providerUsageService: usage }));
vi.mock('@shared/core/providers/agent-provider-registry', () => ({
  isValidProviderId: (id: unknown) => id === 'example',
}));

it('rejects unknown provider IDs and non-boolean activity flags before calling the service', async () => {
  expect(await providerUsageController.refresh('missing')).toMatchObject({ success: false });
  expect(providerUsageController.setActive('true' as unknown as boolean)).toMatchObject({
    success: false,
  });
  expect(usage.refresh).not.toHaveBeenCalled();
  expect(usage.setActive).not.toHaveBeenCalled();
});

it('accepts registered provider IDs and refreshing all providers', async () => {
  expect(await providerUsageController.refresh('example')).toMatchObject({ success: true });
  expect(await providerUsageController.refresh()).toMatchObject({ success: true });
  expect(providerUsageController.setActive(false)).toMatchObject({ success: true });
  expect(usage.refresh.mock.calls).toEqual([['example'], [undefined]]);
  expect(usage.setActive).toHaveBeenCalledWith(false);
});
