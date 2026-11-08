export interface OwnerNotice {
  id: string;
  owner_id: string;
  tenant_id: string;
  kind: "unverified_agent_invite";
  agent_name: string;
  room_name: string;
  created_at: string;
}

export class OwnerNoticesUnsupported extends Error {}

export async function fetchOwnerNotices(signal?: AbortSignal): Promise<OwnerNotice[]> {
  const response = await fetch("/gateway/owner-notices", {
    credentials: "include",
    signal,
  });
  if (response.status === 404) throw new OwnerNoticesUnsupported();
  if (!response.ok) throw new Error(`Could not load notices (${response.status}).`);
  return (await response.json()) as OwnerNotice[];
}

export async function dismissOwnerNotice(id: string): Promise<void> {
  const response = await fetch(`/gateway/owner-notices/${encodeURIComponent(id)}`, {
    credentials: "include",
    method: "DELETE",
  });
  if (!response.ok) throw new Error(`Could not dismiss the notice (${response.status}).`);
}
