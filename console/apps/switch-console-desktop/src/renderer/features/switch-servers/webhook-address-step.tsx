import { WebhookAddressStep as SharedWebhookAddressStep } from '@switch-console/chat-ui/components/connect-messaging-app';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { CONSOLE_MESSAGING_APP_WORDS } from './connect-form-fields';

/** The shared webhook address step, naming the platform as the server described it. */
export function WebhookAddressStep({
  platform,
  webhookUrl,
}: {
  platform: string;
  webhookUrl: string | null;
}) {
  return (
    <SharedWebhookAddressStep
      label={bridgePlatformLabel(platform)}
      webhookUrl={webhookUrl}
      words={CONSOLE_MESSAGING_APP_WORDS}
    />
  );
}
