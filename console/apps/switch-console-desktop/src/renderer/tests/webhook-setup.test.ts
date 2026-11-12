import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { WebhookAddressStep } from '@renderer/features/switch-servers/webhook-address-step';

it('keeps generated secrets available even when the server has no webhook address', () => {
  const html = renderToStaticMarkup(
    createElement(WebhookAddressStep, {
      platform: 'webhook',
      webhookUrl: null,
      setupValues: { inbound_token: 'demo-inbound-value', signing_secret: 'demo-signing-value' },
    })
  );
  expect(html).toContain('MESSAGING_PUBLIC_URL');
  expect(html).toContain('shown only once');
  expect(html.match(/type="password"/g)).toHaveLength(2);
  expect(html).toContain('Copy inbound token');
  expect(html).toContain('Copy signing secret');
});

it('keeps existing webhook connections compatible when there are no generated secrets', () => {
  const html = renderToStaticMarkup(
    createElement(WebhookAddressStep, {
      platform: 'webhook',
      webhookUrl: 'https://switch.example/messaging/bridges/one/events',
    })
  );
  expect(html).not.toContain('type="password"');
  expect(html).not.toContain('shown only once');
  expect(html).toContain('https://switch.example/messaging/bridges/one/events');
});
