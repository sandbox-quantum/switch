import appLevelTokensShot from '@switch-console/chat-ui/assets/slack-setup/app-level-tokens.png';
import installAppShot from '@switch-console/chat-ui/assets/slack-setup/install-app.png';
import type { OwnAppGuideProps } from '@switch-console/chat-ui/components/connect-messaging-app';
import {
  SlackOwnAppGuide,
  type SlackSetupShot,
} from '@switch-console/chat-ui/components/slack-own-app-guide';
import { bridgeSetupDocsUrl } from '@renderer/lib/components/bridge-platform';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { openExternalUrl } from '@renderer/lib/open-external';
import { ExpandableImage } from '@renderer/lib/ui/expandable-image';

const SHOTS: Record<SlackSetupShot, string> = {
  'install-app': installAppShot,
  'app-level-tokens': appLevelTokensShot,
};

/**
 * The shared Slack app setup, reaching the server through Console's IPC, with
 * its pictures expandable to full size. Discord has no way to pre-fill an app,
 * so it keeps the setup guide alone.
 */
export function OwnAppGuide({ workspaceId, ...props }: OwnAppGuideProps & { workspaceId: string }) {
  return (
    <SlackOwnAppGuide
      {...props}
      host={{
        scope: workspaceId,
        thisServer: 'this server',
        setup: () => rpc.workspaces.slackOwnAppSetup(workspaceId),
        checkTokens: (tokens) => rpc.workspaces.checkSlackTokens({ workspaceId, ...tokens }),
        docsUrl: bridgeSetupDocsUrl('slack'),
        openExternal: openExternalUrl,
        describeError: failureText,
        renderShot: (shot, alt) => (
          <ExpandableImage
            src={SHOTS[shot]}
            alt={alt}
            containerClassName="block"
            className="w-full rounded-lg"
          />
        ),
      }}
    />
  );
}
