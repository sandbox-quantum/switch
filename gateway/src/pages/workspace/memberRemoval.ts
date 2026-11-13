import type { Member, MemberRemovalResult, RemovalHeir } from "../../data/api";

/** What removing someone from a workspace, or leaving it, does to what they
 * own there, worded once for every page that removes members. */

type HandedOver = MemberRemovalResult["handed_over"];

const HANDED_OVER_LABELS: Record<keyof HandedOver, [string, string]> = {
  room: ["room", "rooms"],
  package: ["package", "packages"],
  reference: ["reference", "references"],
  reference_type: ["reference type", "reference types"],
  document: ["library document", "library documents"],
  template: ["template", "templates"],
};

function heirLabel(heir: RemovalHeir, selfId: string): string {
  return heir.user_id === selfId ? "you" : `${heir.name} (${heir.email})`;
}

function handedOverSummary(handed: HandedOver): string {
  return (Object.keys(HANDED_OVER_LABELS) as (keyof HandedOver)[])
    .filter((kind) => (handed[kind] ?? 0) > 0)
    .map((kind) => {
      const count = handed[kind] ?? 0;
      const [one, many] = HANDED_OVER_LABELS[kind];
      return `${count} ${count === 1 ? one : many}`;
    })
    .join(", ");
}

/** What the removal moved, and to whom, as the server reports it. */
export function removalNotice(member: Member, result: MemberRemovalResult, selfId: string): string {
  const leaving = member.user_id === selfId;
  const done = leaving ? "You left the workspace." : `Removed ${member.name}.`;
  const owner = leaving ? "you" : "they";
  const summary = handedOverSummary(result.handed_over);
  if (result.handed_over_to && summary) {
    return `${done} What ${owner} owned there passed to ${heirLabel(result.handed_over_to, selfId)}: ${summary}.`;
  }
  return `${done} Nothing ${owner} owned there changed hands.`;
}

/** What the removal will do, before it is confirmed: `heir` is who the server
 * would hand what they own to now, or null when the workspace has no other
 * admin. */
export function removalDescription(member: Member, heir: RemovalHeir | null, selfId: string): string {
  const leaving = member.user_id === selfId;
  const lose = leaving
    ? "You will lose access to this workspace, along with your API keys and connector sign-ins here."
    : `${member.name} will lose access to this workspace, along with their API keys and connector sign-ins here.`;
  const owned = leaving ? "you own" : "they own";
  if (heir === null) {
    return `${lose} The workspace has no other admin, so what ${owned} here stays ${leaving ? "yours" : "theirs"}.`;
  }
  return (
    `${lose} Anything ${owned} here (rooms, packages, references, reference types, ` +
    `library documents and templates) passes to ${heirLabel(heir, selfId)}. Chats stay as they are.`
  );
}
