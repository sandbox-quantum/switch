import {
  type BridgeIcons,
  MessagingAppSelector as SharedMessagingAppSelector,
  type MessagingAppSelectorProps,
  messagingOptions as sharedMessagingOptions,
  NO_MESSAGING_APP,
} from '@switch-console/chat-ui/components/messaging-app-selector';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';

/** Value of the Switch Console option, which needs no messaging app. */
export const SWITCH_CONSOLE = NO_MESSAGING_APP;

const HOME_LABEL = 'Switch Console';
const ICONS: BridgeIcons = { BridgeIcon, hasBridgeIcon };

/** Switch Console, then each app a room can be created on. */
export function messagingOptions(bridges: MessagingAppSelectorProps['bridges']) {
  return sharedMessagingOptions(bridges, HOME_LABEL);
}

/** Where a room lives, offering Switch Console and the apps with Switch Console's icons. */
export function MessagingAppSelector(props: MessagingAppSelectorProps) {
  return <SharedMessagingAppSelector {...props} homeLabel={HOME_LABEL} icons={ICONS} />;
}
