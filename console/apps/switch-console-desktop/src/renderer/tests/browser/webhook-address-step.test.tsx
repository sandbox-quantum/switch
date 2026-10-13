import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { WebhookAddressStep } from '@renderer/features/switch-servers/webhook-address-step';
import { learnBridgePlatforms } from '@renderer/lib/components/bridge-platform';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
  return container;
}

describe('the step after connecting a webhook platform', () => {
  learnBridgePlatforms([
    {
      key: 'dummy_hook',
      displayName: 'Dummy Hook',
      docsSlug: null,
      iconSvg: null,
      receivesWebhooks: true,
      fields: [],
      channelCreationSupported: false,
      directorySearchSupported: false,
    },
  ]);

  it('hands over the address, naming the platform', async () => {
    const url = 'https://switch.example/messaging/bridges/b-1/events';
    const el = await render(<WebhookAddressStep platform="dummy_hook" webhookUrl={url} />);

    expect(el.textContent).toContain('Give Dummy Hook this address');
    expect(el.querySelector('input')?.value).toBe(url);
    expect(el.textContent).not.toContain('dummy_hook');
  });

  it('says what is missing when the server has no public address', async () => {
    const el = await render(<WebhookAddressStep platform="dummy_hook" webhookUrl={null} />);

    expect(el.textContent).toContain('MESSAGING_PUBLIC_URL');
    expect(el.querySelector('input')).toBeNull();
  });
});
