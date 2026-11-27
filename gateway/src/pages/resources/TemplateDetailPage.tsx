import "@switch-console/chat-ui/theme.css";
import {
  FactRow,
  TemplateCreates,
  TemplateDetailError,
  TemplateDetailFrame,
  TemplateDetailHeader,
  TemplateDetailLoading,
  TemplateDocument,
  TemplateProblem,
} from "@switch-console/chat-ui/components/template-detail";
import { SHARED_UI_CLASS } from "@switch-console/chat-ui/model/scope";
import { kindOf } from "@switch-console/chat-ui/model/template-filters";
import {
  TEMPLATE_ACCESS_OPTIONS,
  type TemplateAccess,
  accessLine,
  accessOf,
  visibilityOf,
} from "@switch-console/chat-ui/model/template-visibility";
import { Alert, AlertAction, AlertDescription } from "@switch-console/chat-ui/primitives/alert";
import { Button } from "@switch-console/chat-ui/primitives/button";
import { Field, FieldDescription, FieldLabel } from "@switch-console/chat-ui/primitives/field";
import { Input } from "@switch-console/chat-ui/primitives/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@switch-console/chat-ui/primitives/select";
import { Textarea } from "@switch-console/chat-ui/primitives/textarea";
import { ArrowRightLeft, Check, Copy, Download, Pencil, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import ConfirmDialog from "../../components/ConfirmDialog";
import { TransferOwnershipDialog } from "../../components/TransferOwnershipSection";
import { useAuth } from "../../data/AuthContext";
import {
  ApiError,
  type TemplateDetail,
  type TemplateUseCase,
  deleteTemplate,
  fetchTemplate,
  fetchTemplateContent,
  updateTemplate,
} from "../../data/api";
import { formatDateTime } from "../../theme/format";
import { duplicateDraft } from "../templates/duplicate";
import TemplateRunDialog from "../templates/TemplateRunDialog";
import { FORMER_MEMBER, USE_CASES, createsLine, useCaseLabel } from "../templates/templateRows";
import CreateTemplateDialog, { type TemplateDraft } from "./CreateTemplateDialog";
import { formatBytes, templateFilename } from "./templateFormat";
import { useTemplateValidation } from "./useTemplateValidation";

const LIST_URL = "/templates";
const NO_USE_CASE = "none";

/** What the server's 404 means here. It does not say which, on purpose: a
 * private template is reported as missing to anyone who may not see it. */
export const NOT_AVAILABLE =
  "This template isn’t available to you. Its owner may keep it private, or it may have been deleted.";

/** Why someone who may not edit the template can only read it. */
function readOnlyReason(template: TemplateDetail): string {
  if (template.official) {
    return "Maintained by Switch, so nobody can change it. Copy or download it to make your own version.";
  }
  return template.owner_name === null
    ? "This template belongs to a former member. You can copy or download it; only a workspace admin can change it."
    : `This template belongs to ${template.owner_name}. You can copy or download it; only they or a workspace admin can change it.`;
}

/**
 * One template, as Switch Console shows it: its name and whose it is, what it
 * creates, and its document, with Use, Edit, Duplicate, Transfer and Delete
 * as the server says the viewer may.
 */
export default function TemplateDetailPage() {
  return (
    <div className={`${SHARED_UI_CLASS} flex min-h-0 flex-1 flex-col`}>
      <TemplateDetail />
    </div>
  );
}

function TemplateDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [template, setTemplate] = useState<TemplateDetail | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [useOpen, setUseOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showDocument, setShowDocument] = useState(false);
  const [copy, setCopy] = useState<TemplateDraft | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setTemplate(null);
    setFetchError(null);
    fetchTemplate(id)
      .then((t) => {
        if (!cancelled) setTemplate(t);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // A template the caller may not see is reported as not found; any
        // other failure keeps the server's reason, since a template they may
        // not see and a server that is down are different problems.
        setFetchError(
          e instanceof ApiError && e.status === 404
            ? NOT_AVAILABLE
            : e instanceof Error
              ? e.message
              : "Could not load this template",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const back = () => navigate(LIST_URL);
  if (fetchError || !id) return <TemplateDetailError error={fetchError ?? "Template not found"} onBack={back} />;
  if (!template) return <TemplateDetailLoading />;

  // The server says what this user may do. The user's global role would not:
  // a workspace admin whose global role is plain "user" may still manage
  // every template here, and an open template is edited by anyone.
  const canEdit = template.can_edit;
  // On an official template, managing it means only removing it from the workspace.
  const canManage = template.can_manage;
  const official = template.official;
  const blocked = template.run_blocked_reason;
  const ownerLine = official
    ? "Comes with Switch"
    : user !== null && template.owner_id === user.id
      ? "Yours"
      : `Uploaded by ${template.owner_name ?? FORMER_MEMBER.toLowerCase()}`;

  const duplicate = async () => {
    setCopyError(null);
    try {
      if (user === null) throw new Error("you are not signed in");
      setCopy(await duplicateDraft(template, user.id));
    } catch (e) {
      setCopyError(`Could not copy “${template.name}”: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <TemplateDetailFrame>
      <TemplateDetailHeader
        name={template.name || "Template"}
        description={template.description}
        ownerLine={ownerLine}
        accessLine={accessLine(accessOf({ readVisibility: template.read_visibility, writeVisibility: template.write_visibility }))}
        version={template.version}
        kind={kindOf(template.kind)}
        official={official}
        onBack={back}
        actions={
          <>
            {canEdit && !editing && (
              <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil className="size-3.5" />
                Edit
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => void duplicate()}>
              <Copy className="size-3.5" />
              Duplicate as my own
            </Button>
            {canManage && !official && (
              <Button type="button" variant="outline" size="sm" onClick={() => setTransferOpen(true)}>
                <ArrowRightLeft className="size-3.5" />
                Transfer ownership
              </Button>
            )}
            {canManage && (
              <Button type="button" variant="outline" size="sm" onClick={() => setDeleteOpen(true)}>
                <Trash2 className="size-3.5" />
                {official ? "Remove from this workspace" : "Delete template"}
              </Button>
            )}
            {/* Greyed with `aria-disabled` rather than `disabled`, so it stays
                in the focus order and its reason can be reached. */}
            <Button
              type="button"
              size="sm"
              aria-disabled={blocked !== null || undefined}
              title={blocked ?? undefined}
              className={blocked !== null ? "cursor-default opacity-50" : undefined}
              onClick={blocked === null ? () => setUseOpen(true) : undefined}
            >
              Use template
            </Button>
          </>
        }
      />

      {copyError && (
        <Alert variant="destructive">
          <AlertDescription>{copyError}</AlertDescription>
          <AlertAction>
            <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={() => setCopyError(null)}>
              <X className="size-3.5" />
            </Button>
          </AlertAction>
        </Alert>
      )}
      {!canEdit && <p className="text-sm text-foreground-muted">{readOnlyReason(template)}</p>}
      {template.agent_count === null && (
        <TemplateProblem problem="Its document could not be read." canFix={canEdit || canManage} />
      )}

      <TemplateCreates creates={null} summary={createsLine(template)}>
        <div className="flex flex-col gap-2 pt-1">
          <FactRow label="Use case">{template.use_case ? useCaseLabel(template.use_case) : "None"}</FactRow>
          <FactRow label="Runs">{template.run_count}</FactRow>
          <FactRow label="Last used">
            {template.last_run_at === null ? "Never" : formatDateTime(template.last_run_at)}
          </FactRow>
          <FactRow label="Size">{formatBytes(template.size_bytes)}</FactRow>
          {/* One that comes with Switch changes only with a release, so it
              has no dates of its own. */}
          {!official && (
            <>
              <FactRow label="Created">{formatDateTime(template.created_at)}</FactRow>
              <FactRow label="Updated">{formatDateTime(template.updated_at)}</FactRow>
            </>
          )}
        </div>
      </TemplateCreates>

      {editing && (
        <EditTemplate
          template={template}
          canManage={canManage && !official}
          onSaved={(updated) => {
            setTemplate(updated);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      )}

      <TemplateDocument
        open={showDocument}
        onToggle={() => setShowDocument((o) => !o)}
        fileName={templateFilename(template.name)}
        note="Stored exactly as uploaded"
        actions={<DocumentActions template={template} />}
        document={template.content}
      />

      <ConfirmDialog
        open={deleteOpen}
        title={official ? "Remove template" : "Delete template"}
        description={
          official
            ? `Remove “${template.name || id}” from this workspace? It comes with Switch, so other workspaces keep it. Agents and rooms already made from it keep working. This can’t be undone.`
            : `Delete “${template.name || id}”? Agents and rooms already made from it keep working. This can’t be undone.`
        }
        confirmLabel={official ? "Remove" : "Delete"}
        tone="destructive"
        onConfirm={async () => {
          await deleteTemplate(id);
          navigate(LIST_URL);
        }}
        onClose={() => setDeleteOpen(false)}
      />
      {transferOpen && (
        <TransferOwnershipDialog
          kind="template"
          resourceId={id}
          resourceLabel={template.name || id}
          ownerId={template.owner_id}
          onClose={() => setTransferOpen(false)}
          onTransferred={() => navigate(0)}
        />
      )}
      {useOpen && (
        <TemplateRunDialog templateId={template.id} templateName={template.name} onClose={() => setUseOpen(false)} />
      )}
      {copy && (
        <CreateTemplateDialog
          open
          title="Duplicate template"
          submitLabel="Save copy"
          initial={copy}
          onClose={() => setCopy(null)}
          onCreated={(created) => {
            setCopy(null);
            navigate(`/templates/${encodeURIComponent(created)}`);
          }}
        />
      )}
    </TemplateDetailFrame>
  );
}

/** Copy and Download on the document's bar. Both go back to the server for
 * the document rather than using the copy on screen, so what you take is what
 * is stored even while the edit form holds unsaved changes. */
function DocumentActions({ template }: { template: TemplateDetail }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const withStoredDocument = async (use: (text: string) => Promise<void> | void) => {
    setError(null);
    setCopied(false);
    try {
      await use(await fetchTemplateContent(template.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch document");
    }
  };

  const handleCopy = () =>
    withStoredDocument(async (text) => {
      // Absent outside a secure context, where the bare property access would
      // read as "failed to fetch document" rather than the truth.
      if (!navigator.clipboard) {
        throw new Error("Copying needs a secure connection (HTTPS).");
      }
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });

  const handleDownload = () =>
    withStoredDocument((text) => {
      const url = URL.createObjectURL(new Blob([text], { type: "application/x-yaml" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = templateFilename(template.name);
      document.body.appendChild(a);
      a.click();
      a.remove();
      // The click only queues the download; revoking in the same tick can pull
      // the blob out from under a browser that has not read it yet.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });

  return (
    <>
      {error && (
        <span role="alert" className="text-foreground-destructive">
          {error}
        </span>
      )}
      <Button type="button" variant="outline" size="sm" onClick={() => void handleCopy()}>
        {copied ? <Check className="size-3.5 text-foreground-success" /> : <Copy className="size-3.5" />}
        {copied ? "Copied" : "Copy"}
      </Button>
      <Button type="button" variant="ghost" size="xs" onClick={() => void handleDownload()}>
        <Download className="size-3.5" />
        Download
      </Button>
    </>
  );
}

/** The template's fields and document, editable, for someone the server lets
 * change it. */
function EditTemplate({
  template,
  canManage,
  onSaved,
  onCancel,
}: {
  template: TemplateDetail;
  /** Only the owner or an admin changes who may see or edit it. */
  canManage: boolean;
  onSaved: (updated: TemplateDetail) => void;
  onCancel: () => void;
}) {
  const stored = accessOf({ readVisibility: template.read_visibility, writeVisibility: template.write_visibility });
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description);
  const [kind, setKind] = useState(template.kind);
  const [useCase, setUseCase] = useState<TemplateUseCase | null>(template.use_case);
  const [access, setAccess] = useState<TemplateAccess>(stored);
  const [content, setContent] = useState(template.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { result: validation, checking } = useTemplateValidation(content);

  const dirty = useMemo(
    () =>
      name !== template.name ||
      description !== template.description ||
      kind !== template.kind ||
      useCase !== template.use_case ||
      content !== template.content ||
      access !== stored,
    [name, description, kind, useCase, content, access, template, stored],
  );

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const { readVisibility, writeVisibility } = visibilityOf(access);
      // Only what changed is sent, so an edit to the name or the access
      // cannot put back a document someone else saved meanwhile.
      onSaved(
        await updateTemplate(template.id, {
          ...(name !== template.name ? { name } : {}),
          ...(description !== template.description ? { description } : {}),
          ...(kind !== template.kind ? { kind } : {}),
          ...(useCase !== template.use_case ? { use_case: useCase } : {}),
          ...(content !== template.content ? { content } : {}),
          // Sent only by someone allowed to change it; the server refuses it otherwise.
          ...(canManage && access !== stored
            ? { read_visibility: readVisibility, write_visibility: writeVisibility }
            : {}),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
      setSaving(false);
    }
  };

  return (
    <section className="flex flex-col gap-4" aria-label="Edit template">
      <h2 className="text-sm font-semibold text-foreground">Edit</h2>
      <Field>
        <FieldLabel htmlFor="template-name">Name</FieldLabel>
        <Input id="template-name" value={name} onChange={(e) => setName(e.target.value)} disabled={saving} />
      </Field>
      <Field>
        <FieldLabel htmlFor="template-description">Description</FieldLabel>
        <Textarea
          id="template-description"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={saving}
        />
        <FieldDescription>Shown in the catalogue, and searched alongside the name.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="template-kind">Kind</FieldLabel>
        <Input id="template-kind" value={kind} onChange={(e) => setKind(e.target.value)} disabled={saving} />
      </Field>
      <Field>
        <FieldLabel>Use case</FieldLabel>
        <Select
          value={useCase ?? NO_USE_CASE}
          onValueChange={(next) => setUseCase(next === NO_USE_CASE ? null : (next as TemplateUseCase))}
          disabled={saving}
        >
          <SelectTrigger aria-label="Use case" className="w-72">
            <SelectValue>{useCase ? useCaseLabel(useCase) : "None"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_USE_CASE}>None</SelectItem>
            {USE_CASES.map((u) => (
              <SelectItem key={u.value} value={u.value}>
                {u.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>Optional. Shown on the template's page, and searched alongside its name.</FieldDescription>
      </Field>
      {canManage && (
        <Field>
          <FieldLabel>Access</FieldLabel>
          <Select value={access} onValueChange={(next) => setAccess(next as TemplateAccess)} disabled={saving}>
            <SelectTrigger aria-label="Access" className="w-72">
              <SelectValue>{TEMPLATE_ACCESS_OPTIONS.find((o) => o.value === access)?.label}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {TEMPLATE_ACCESS_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>{TEMPLATE_ACCESS_OPTIONS.find((o) => o.value === access)?.hint}</FieldDescription>
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor="template-document">Document</FieldLabel>
        <Textarea
          id="template-document"
          rows={16}
          className="font-mono text-xs"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          disabled={saving}
        />
        <FieldDescription>Saving a changed document bumps the revision.</FieldDescription>
      </Field>
      {!checking && validation && validation.errors.length > 0 && (
        <Alert variant="destructive">
          <AlertDescription>
            <p className="font-medium">
              {validation.errors.length === 1
                ? "This does not look like a valid template"
                : `${validation.errors.length} problems with this template`}
            </p>
            <ul className="list-disc pl-5">
              {validation.errors.map((f, i) => (
                <li key={`${f.code}-${f.subject ?? i}`}>{f.message}</li>
              ))}
            </ul>
            {validation.blocked
              ? "This cannot be saved until it parses."
              : "You can still save it — the registry stores documents it does not understand — but check this is what you meant."}
          </AlertDescription>
        </Alert>
      )}
      {!checking && validation && validation.warnings.length > 0 && (
        <Alert variant="warning">
          <AlertDescription>
            <ul className="list-disc pl-5">
              {validation.warnings.map((f, i) => (
                <li key={`${f.code}-${f.subject ?? i}`}>{f.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex gap-2">
        <Button onClick={() => void save()} disabled={!dirty || saving || checking || !!validation?.blocked}>
          Save
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
