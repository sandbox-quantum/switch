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
export function removalNotice(
  member: Pick<Member, "user_id" | "name">,
  result: MemberRemovalResult,
  selfId: string,
  /** The workspace by name, where the page is not that workspace's own. */
  workspaceName: string | null,
): string {
  const leaving = member.user_id === selfId;
  const done =
    workspaceName === null
      ? leaving
        ? "You left the workspace."
        : `Removed ${member.name}.`
      : leaving
        ? `You left ${workspaceName}.`
        : `Removed ${member.name} from ${workspaceName}.`;
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
export function removalDescription(
  member: Pick<Member, "user_id" | "name">,
  heir: RemovalHeir | null,
  selfId: string,
  /** The workspace by name, where the page is not that workspace's own. */
  workspaceName: string | null,
): string {
  const leaving = member.user_id === selfId;
  const where = workspaceName ?? "this workspace";
  const place = workspaceName === null ? "here" : "there";
  const lose = leaving
    ? `You will lose access to ${where}, along with your API keys and connector sign-ins ${place}.`
    : `${member.name} will lose access to ${where}, along with their API keys and connector sign-ins ${place}.`;
  const owned = leaving ? "you own" : "they own";
  if (heir === null) {
    return `${lose} The workspace has no other admin, so what ${owned} here stays ${leaving ? "yours" : "theirs"}.`;
  }
  return (
    `${lose} Anything ${owned} here (rooms, packages, references, reference types, ` +
    `library documents and templates) passes to ${heirLabel(heir, selfId)}. Chats stay as they are.`
  );
}
