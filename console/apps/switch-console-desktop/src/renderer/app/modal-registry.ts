import { CommandPaletteModal } from '@renderer/features/command-palette/command-palette-modal';
import { AddAgentModal } from '@renderer/features/locations/components/add-agent-modal/add-agent-modal';
import { DeleteAgentModal } from '@renderer/features/locations/components/delete-agent-modal';
import { RemoveAgentConfigModal } from '@renderer/features/remote-hosts/remove-agent-config-modal';
import { ResetAgentModal } from '@renderer/features/locations/components/reset-agent-modal';
import { AddHostModal } from '@renderer/features/remote-hosts/add-host-modal';
import { CreateSessionModal } from '@renderer/features/sessions/create-session-modal/create-session-modal';
import { DeleteSessionModal } from '@renderer/features/sessions/delete-session-modal';
import { RenameSessionModal } from '@renderer/features/sessions/rename-session-modal';
import { AddAgentsToRoomModal } from '@renderer/features/switch-rooms/AddAgentsToRoomModal';
import { AddAgentToRoomsModal } from '@renderer/features/switch-rooms/AddAgentToRoomsModal';
import { DeleteRoomModal } from '@renderer/features/switch-rooms/DeleteRoomModal';
import { AddServerModal } from '@renderer/features/switch-servers/AddServerModal';
import { AssignServerModal } from '@renderer/features/switch-servers/assign-server-modal';
import { BundledChatSignInModal } from '@renderer/features/switch-servers/BundledChatSignIn';
import { ClaimIdentityModal } from '@renderer/features/switch-servers/ClaimIdentityModal';
import { ConnectMessagingAppModal } from '@renderer/features/switch-servers/ConnectMessagingAppModal';
import { CreateRoomModal } from '@renderer/features/switch-servers/CreateRoomModal';
import { DeleteServerModal } from '@renderer/features/switch-servers/DeleteServerModal';
import { DisconnectMessagingAppModal } from '@renderer/features/switch-servers/DisconnectMessagingAppModal';
import { RenameServerModal } from '@renderer/features/switch-servers/RenameServerModal';
import { ConfirmActionDialog } from '@renderer/lib/components/confirm-action-dialog';
import { ExternalLinkChoiceDialog } from '@renderer/lib/components/external-link-choice-dialog';
import { UnsavedChangesDialog } from '@renderer/lib/components/unsaved-changes-dialog';
import { type ModalComponent } from '@renderer/lib/modal/modal-provider';

export type ModalSize = 'xs' | 'sm' | 'md' | 'lg';
export type ModalPosition = 'center' | 'top';

export type ModalRegistryEntry<TProps = unknown, TResult = unknown> = {
  component: ModalComponent<TProps, TResult>;
  size?: ModalSize;
  position?: ModalPosition;
  /**
   * Whether a click on the backdrop dismisses the modal. Defaults to `true`.
   * Set `false` for data-entry modals so a stray outside click does not
   * discard in-progress input; the Escape key and close/Cancel buttons still
   * dismiss.
   */
  dismissOnOutsideClick?: boolean;
};

export function createModal<TProps, TResult>(
  component: ModalComponent<TProps, TResult>,
  config: Omit<ModalRegistryEntry, 'component'> = {}
): ModalRegistryEntry<TProps, TResult> {
  return { component, ...config };
}

export const modalRegistry = {
  commandPaletteModal: createModal(CommandPaletteModal, { size: 'md' }),
  sessionModal: createModal(CreateSessionModal, { dismissOnOutsideClick: false }),
  addAgentModal: createModal(AddAgentModal, { size: 'lg', dismissOnOutsideClick: false }),
  confirmActionModal: createModal(ConfirmActionDialog, { size: 'xs' }),
  deleteAgentModal: createModal(DeleteAgentModal, { size: 'sm' }),
  removeAgentConfigModal: createModal(RemoveAgentConfigModal, { size: 'sm' }),
  resetAgentModal: createModal(ResetAgentModal, { size: 'sm' }),
  confirmExternalLinkModal: createModal(ExternalLinkChoiceDialog, { size: 'sm' }),
  unsavedChangesModal: createModal(UnsavedChangesDialog, { size: 'xs' }),
  renameSessionModal: createModal(RenameSessionModal, {
    size: 'xs',
    dismissOnOutsideClick: false,
  }),
  deleteSessionModal: createModal(DeleteSessionModal, { size: 'sm' }),
  addServerModal: createModal(AddServerModal, { size: 'md', dismissOnOutsideClick: false }),
  addHostModal: createModal(AddHostModal, { size: 'md', dismissOnOutsideClick: false }),
  assignServerModal: createModal(AssignServerModal, { size: 'sm', dismissOnOutsideClick: false }),
  renameServerModal: createModal(RenameServerModal, {
    size: 'xs',
    dismissOnOutsideClick: false,
  }),
  deleteServerModal: createModal(DeleteServerModal, { size: 'sm' }),
  createRoomModal: createModal(CreateRoomModal, { size: 'lg', dismissOnOutsideClick: false }),
  connectMessagingAppModal: createModal(ConnectMessagingAppModal, {
    size: 'md',
    dismissOnOutsideClick: false,
  }),
  claimIdentityModal: createModal(ClaimIdentityModal, {
    size: 'md',
    dismissOnOutsideClick: false,
  }),
  bundledChatSignInModal: createModal(BundledChatSignInModal, { size: 'sm' }),
  disconnectMessagingAppModal: createModal(DisconnectMessagingAppModal, {
    size: 'sm',
    dismissOnOutsideClick: false,
  }),
  addAgentsToRoomModal: createModal(AddAgentsToRoomModal, {
    // The room-side twin of `addAgentToRoomModal`, and sized to match: the two
    // do the same job from opposite ends and should not feel like two dialogs.
    size: 'lg',
    dismissOnOutsideClick: false,
  }),
  addAgentToRoomModal: createModal(AddAgentToRoomsModal, {
    // Wide enough for a searchable list and a grid of what you have picked —
    // this dialog browses a whole server's rooms, not just confirms one.
    size: 'lg',
    dismissOnOutsideClick: false,
  }),
  deleteRoomModal: createModal(DeleteRoomModal, { size: 'sm', dismissOnOutsideClick: false }),
  // oxlint-disable-next-line typescript/no-explicit-any
} satisfies Record<string, ModalRegistryEntry<any, any>>;
