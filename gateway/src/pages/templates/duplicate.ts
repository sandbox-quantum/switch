import { type TemplateSummary, fetchTemplateContent, fetchTemplates } from "../../data/api";
import type { TemplateDraft } from "../resources/CreateTemplateDialog";
import { copyName } from "./templateRows";

/** The form "Duplicate as my own" opens on: the template's document as
 * stored, under a copy name `viewerId` does not already use. */
export async function duplicateDraft(template: TemplateSummary, viewerId: string): Promise<TemplateDraft> {
  const [content, mine] = await Promise.all([
    fetchTemplateContent(template.id),
    fetchTemplates({ owner_id: viewerId }),
  ]);
  return {
    name: copyName(template.name, new Set(mine.map((t) => t.name))),
    description: template.description,
    kind: template.kind,
    use_case: template.use_case,
    // Private until its new owner says otherwise: an admin may be copying a
    // template only its owner and the admins could see.
    access: "private",
    content,
  };
}
