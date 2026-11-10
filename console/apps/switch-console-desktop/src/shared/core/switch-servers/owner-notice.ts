/** A notice the gateway has selected for the signed-in owner in this workspace. */
export type OwnerNotice = {
  id: string;
  kind: 'unverified_agent_invite';
  agentName: string;
  roomName: string;
  createdAt: string;
};

export type OwnerNoticeList = { supported: true; notices: OwnerNotice[] } | { supported: false };
