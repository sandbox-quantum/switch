import type { TemplateSummary } from "../../data/api";

/** The longest name the server stores (`TEMPLATE_NAME_MAX`). */
export const TEMPLATE_NAME_MAX = 200;

/** What the catalogue calls an owner who has left the workspace. */
export const FORMER_MEMBER = "Former member";

const KIND_LABELS: Record<string, string> = { agent: "Agent", room: "Room", group: "Group" };

/** A template's kind as the Type column shows it. Kinds are free text, so
 * one the product does not name is shown as written. */
export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

export function ownerLabel(template: TemplateSummary): string {
  return template.owner_name ?? FORMER_MEMBER;
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

export type TemplateAction = "run" | "edit" | "duplicate" | "delete";

/** One item of a template's row menu, with why it is greyed when it is. */
export interface TemplateMenuItem {
  action: TemplateAction;
  disabledReason: string | null;
}

/** A template's row menu, from what the server says the viewer may do.
 * Run, Duplicate and creating are everyone's; Edit follows `can_edit` and
 * Delete `can_manage`. A template that comes with Switch is changed by
 * nobody and deleted by nobody, so it has no Delete at all. */
export function templateMenu(template: TemplateSummary): TemplateMenuItem[] {
  const run: TemplateMenuItem = { action: "run", disabledReason: template.run_blocked_reason };
  const duplicate: TemplateMenuItem = { action: "duplicate", disabledReason: null };
  if (template.official) {
    return [run, { action: "edit", disabledReason: OFFICIAL_EDIT_REASON }, duplicate];
  }
  return [
    run,
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

/** Newest first, as the shared table opens. The server's timestamps share
 * one format, so they sort as text. */
export function newestFirst(templates: readonly TemplateSummary[]): TemplateSummary[] {
  return [...templates].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/** The Switch Console link that opens a template's Use form, in the
 * workspace the dashboard is showing, on the Switch the dashboard belongs to.
 * An older Console ignores `workspace` and `use`, and opens the template's
 * page in whichever workspace it is on. */
export function consoleRunLink(templateId: string, workspaceId: string, origin: string): string {
  const query = new URLSearchParams({ server: origin, workspace: workspaceId, use: "1" });
  return `switchdash://open/template/${encodeURIComponent(templateId)}?${query.toString()}`;
}
