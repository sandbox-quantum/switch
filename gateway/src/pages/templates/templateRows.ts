import type { TemplateSummary, TemplateUseCase } from "../../data/api";
import { absoluteTitle, formatRelative } from "../../theme/format";

/** The longest name the server stores (`TEMPLATE_NAME_MAX`). */
export const TEMPLATE_NAME_MAX = 200;

/** What the catalogue calls an owner who has left the workspace. */
export const FORMER_MEMBER = "Former member";

export type TemplateKind = "agent" | "room" | "group";

export const TEMPLATE_KINDS: readonly { value: TemplateKind; label: string }[] = [
  { value: "agent", label: "Agent" },
  { value: "room", label: "Room" },
  { value: "group", label: "Group" },
];

/** A template's kind as the catalogue files it. The column is free text, so
 * anything the product does not name is shown as a room, as Switch Console
 * shows it. */
export function kindOf(template: Pick<TemplateSummary, "kind">): TemplateKind {
  return template.kind === "agent" || template.kind === "group" ? template.kind : "room";
}

export function kindLabel(kind: TemplateKind): string {
  return TEMPLATE_KINDS.find((k) => k.value === kind)?.label ?? kind;
}

/** The server's list of use cases, in the order a picker offers them. */
export const USE_CASES: readonly { value: TemplateUseCase; label: string }[] = [
  { value: "engineering", label: "Engineering" },
  { value: "product", label: "Product" },
  { value: "support", label: "Support" },
  { value: "research", label: "Research" },
  { value: "ops", label: "Operations" },
  { value: "personal", label: "Personal" },
  { value: "sales", label: "Sales" },
  { value: "marketing", label: "Marketing" },
];

export function useCaseLabel(useCase: TemplateUseCase): string {
  return USE_CASES.find((u) => u.value === useCase)?.label ?? useCase;
}

export function ownerLabel(template: TemplateSummary): string {
  return template.owner_name ?? FORMER_MEMBER;
}

const plural = (n: number, noun: string) => `${n} ${n === 1 ? noun : `${noun}s`}`;

/** "3 agents · 1 room": what the template creates. A part that is zero is
 * left out, since a room template that only invites agents already there
 * creates none, and "0 agents" would read as a room nobody works in. Null
 * when the server could not read the document, or it creates neither. */
export function createsLine(template: TemplateSummary): string | null {
  if (template.agent_count === null || template.room_count === null) return null;
  const parts = [
    template.agent_count > 0 ? plural(template.agent_count, "agent") : null,
    template.room_count > 0 ? plural(template.room_count, "room") : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** "Ada · used 2 days ago", or just the owner for a template never run,
 * with the exact time of the last run for a hover title. */
export function ownerLine(template: TemplateSummary): { text: string; title: string | undefined } {
  const owner = ownerLabel(template);
  if (template.last_run_at === null) return { text: owner, title: undefined };
  const relative = formatRelative(template.last_run_at);
  // Past a week the recency ladder gives a date, which reads as "used on".
  const used = /^\d{4}-/.test(relative) ? `used on ${relative}` : `used ${relative.toLowerCase()}`;
  return { text: `${owner} · ${used}`, title: `Last used ${absoluteTitle(template.last_run_at)}` };
}

/** Why the viewer may not change or delete someone else's template, beside
 * the greyed item. */
function ownedElsewhere(template: TemplateSummary, verb: "change" | "delete"): string {
  if (template.owner_name === null) {
    return `“${template.name}” belongs to a former member. Only a workspace admin can ${verb} it.`;
  }
  return `“${template.name}” belongs to ${template.owner_name}. Only they or a workspace admin can ${verb} it.`;
}

export const OFFICIAL_EDIT_REASON = "Maintained by Switch. Duplicate it to make your own version.";

export type TemplateAction = "edit" | "duplicate" | "delete";

/** One item of a template's "…" menu, with why it is greyed when it is. */
export interface TemplateMenuItem {
  action: TemplateAction;
  disabledReason: string | null;
}

/** A template's "…" menu, from what the server says the viewer may do.
 * Duplicate is everyone's; Edit follows `can_edit` and Delete `can_manage`.
 * A template that comes with Switch is changed by nobody, and removing one
 * from the workspace is done from its page, so it has no Delete here. Using
 * a template is the card's own button, not an item here. */
export function templateMenu(template: TemplateSummary): TemplateMenuItem[] {
  const duplicate: TemplateMenuItem = { action: "duplicate", disabledReason: null };
  if (template.official) {
    return [{ action: "edit", disabledReason: OFFICIAL_EDIT_REASON }, duplicate];
  }
  return [
    { action: "edit", disabledReason: template.can_edit ? null : ownedElsewhere(template, "change") },
    duplicate,
    { action: "delete", disabledReason: template.can_manage ? null : ownedElsewhere(template, "delete") },
  ];
}

/** The name a copy is saved under: "X (copy)", or "X (copy 2)" and on, the
 * first the viewer does not already use (names are unique per owner), cut
 * so the suffix still fits the server's limit. */
export function copyName(name: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? " (copy)" : ` (copy ${n})`;
    const candidate = `${name.slice(0, TEMPLATE_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A Switch Console link to `page`, in the workspace the dashboard is
 * showing, on the Switch the dashboard belongs to. An older Console ignores
 * `workspace` and opens the page in whichever workspace it is on. */
function consoleLink(page: string, workspaceId: string, origin: string, extra: Record<string, string>): string {
  const query = new URLSearchParams({ server: origin, workspace: workspaceId, ...extra });
  return `switchdash://open/${page}?${query.toString()}`;
}

/** The link that opens a template's Use form. An older Console ignores
 * `use` and opens the template's page. */
export function consoleRunLink(templateId: string, workspaceId: string, origin: string): string {
  return consoleLink(`template/${encodeURIComponent(templateId)}`, workspaceId, origin, { use: "1" });
}

/** The link that opens a chat with the person's own agent, switch-buddy. */
export function consoleBuddyLink(workspaceId: string, origin: string): string {
  return consoleLink("buddy", workspaceId, origin, {});
}

/** The link that opens Switch Console's Templates page, where a template is
 * imported, written or made from a room. */
export function consoleTemplatesLink(workspaceId: string, origin: string): string {
  return consoleLink("templates", workspaceId, origin, {});
}
