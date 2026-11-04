import {
  Box,
  Button,
  CircularProgress,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useRef, useState } from "react";
import { useHosted } from "../HostedContext";
import HostedRefusal from "../HostedRefusal";
import AlertTitle from "../w5shared/AlertTitle";
import { isRecord, readOperatorRoute, shortTime, stringOrNull } from "../w5shared/operatorFetch";
import { useSignedOut } from "../w5shared/useSignedOut";
import {
  ACTION_WORDS,
  ADMIN_HAS_REASON,
  ANY_ACTION,
  EMPTY,
  FAILED_AT,
  FAILED_AT_STEP,
  FAILED_WORDS,
  FILTER_ACTIONS,
  ID_PLACEHOLDER,
  LOAD_ERROR,
  LOAD_OLDER,
  NO_VALUE,
  PROVISION_WORDS,
  RESULT_DONE,
  RESULT_DONE_PARTIAL,
  RESULT_FAILED,
  RESULT_PENDING,
  STEP_WORDS,
  TIME_FILTERS,
  WHO_ADMIN,
  WHO_OPERATOR,
  WHO_SERVER_SETTINGS,
  WHO_SWITCH,
  YOU_SUFFIX,
  shortId,
} from "./auditWords";

export const AUDIT_PATH = "/gateway/shared-cloud/audit-events";
/** Core's page size for this view (it allows up to 200). */
export const PAGE_SIZE = 50;
const MAX_ID_FILTER = 128;

export interface AuditEntry {
  id: string;
  occurredAt: string;
  actorUserId: string | null;
  actorName: string | null;
  action: string;
  targetId: string | null;
  details: Record<string, unknown>;
  title: string | null;
}

export function parseEntries(raw: unknown): AuditEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const entries: AuditEntry[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = stringOrNull(item.id);
    const occurredAt = stringOrNull(item.occurred_at);
    const action = stringOrNull(item.action);
    if (id === null || occurredAt === null || action === null) continue;
    entries.push({
      id,
      occurredAt,
      actorUserId: stringOrNull(item.actor_user_id),
      actorName: stringOrNull(item.actor_name),
      action,
      targetId: stringOrNull(item.target_id),
      details: isRecord(item.details) ? item.details : {},
      title: stringOrNull(item.title),
    });
  }
  return entries;
}

/** A cell's words, with an optional code shown after them in monospace (a
 *  code the copy doc has no words for, or an alert's title). */
export interface Words {
  text: string;
  code?: string;
  alertTitle?: string;
}

export interface AuditRow {
  id: string;
  when: string;
  who: string;
  action: Words;
  on: string | null;
  reason: string;
  result: Words;
}

function phaseOf(entry: AuditEntry): string | null {
  return stringOrNull(entry.details.phase);
}

export interface ResultContext {
  /** Box creation (V0) has its own words for its steps. */
  provision?: boolean;
  /** A progress entry for this action reached the `partial` step. */
  partial?: boolean;
}

export function resultWords(result: unknown, step: unknown, ctx: ResultContext = {}): Words {
  if (typeof result !== "string") return { text: NO_VALUE };
  if (result === "done") return { text: ctx.partial ? RESULT_DONE_PARTIAL : RESULT_DONE };
  if (result === "failed") {
    if (typeof step !== "string" || step === "") return { text: RESULT_FAILED };
    if (FAILED_WORDS[step]) return { text: FAILED_WORDS[step] };
    if (ctx.provision && PROVISION_WORDS[step]) return { text: PROVISION_WORDS[step] };
    if (STEP_WORDS[step]) return { text: `${FAILED_AT}${STEP_WORDS[step]}` };
    return { text: FAILED_AT_STEP, code: step };
  }
  if (PROVISION_WORDS[result]) return { text: PROVISION_WORDS[result] };
  return { text: "", code: result };
}

function actionWords(code: string, title: string | null): Words {
  const words = ACTION_WORDS[code];
  if (!words) return { text: "", code };
  if (code.startsWith("alert.") && title) return { text: `${words}: `, alertTitle: title };
  return { text: words };
}

/** One row per action: a request is joined to its result entry (linked by
 *  `linked_to`), and progress and result entries aren't rows of their own.
 *  A result is always newer than its request, so with newest-first pages the
 *  result of any request already loaded is loaded too. */
export function buildRows(entries: AuditEntry[], viewerId: string): AuditRow[] {
  const resultOf = new Map<string, AuditEntry>();
  const partial = new Set<string>();
  for (const entry of entries) {
    const linked = stringOrNull(entry.details.linked_to);
    if (linked === null) continue;
    const phase = phaseOf(entry);
    if (phase === "result") resultOf.set(linked, entry);
    if (phase === "progress" && entry.details.step === "partial") partial.add(linked);
  }
  const rows: AuditRow[] = [];
  for (const entry of entries) {
    const phase = phaseOf(entry);
    if (phase === "result" || phase === "progress") continue;
    const d = entry.details;
    let who: string;
    let action: Words;
    let reason = NO_VALUE;
    let result: Words;
    if (entry.action === "hosted.admin_change") {
      const workspace = stringOrNull(d.workspace);
      who = [
        WHO_ADMIN,
        entry.actorUserId ? shortId(entry.actorUserId) : null,
        workspace ? `(${shortId(workspace)})` : null,
      ]
        .filter(Boolean)
        .join(" ");
      const inner = stringOrNull(d.action);
      action =
        inner && ACTION_WORDS[inner]
          ? { text: ACTION_WORDS[inner] }
          : actionWords(entry.action, null);
      if (d.has_reason === true) reason = ADMIN_HAS_REASON;
      result = resultWords(d.result, d.step);
    } else {
      if (entry.actorUserId === null) {
        who = entry.action.startsWith("operator.") ? WHO_SERVER_SETTINGS : WHO_SWITCH;
      } else {
        who = entry.actorName ?? WHO_OPERATOR;
        if (entry.actorUserId === viewerId) who += YOU_SUFFIX;
      }
      action = actionWords(entry.action, entry.title);
      const typed = stringOrNull(d.reason);
      if (typed !== null && typed.trim() !== "") reason = typed;
      const ctx = {
        provision: entry.action === "hosted.box_provision",
        partial: partial.has(entry.id),
      };
      if (phase === "requested") {
        const outcome = resultOf.get(entry.id);
        result = outcome
          ? resultWords(outcome.details.result, outcome.details.step, ctx)
          : { text: RESULT_PENDING };
      } else {
        result = resultWords(d.result, d.step, ctx);
      }
    }
    rows.push({
      id: entry.id,
      when: shortTime(entry.occurredAt),
      who,
      action,
      on: entry.targetId,
      reason,
      result,
    });
  }
  return rows;
}

export function auditQuery(filters: {
  action: string;
  id: string;
  time: string;
  /** The last entry already shown: the next page starts strictly after it,
   *  in Core's (time, id) order, so entries sharing its time aren't skipped. */
  before?: { occurredAt: string; id: string };
  now?: Date;
}): string {
  const params = new URLSearchParams();
  params.set("limit", String(PAGE_SIZE));
  if (filters.action) params.set("action", filters.action);
  const id = filters.id.trim();
  if (id) params.set("target_id", id.slice(0, MAX_ID_FILTER));
  const hours = TIME_FILTERS.find((t) => t.value === filters.time)?.hours ?? 24 * 7;
  const now = filters.now ?? new Date();
  params.set("since", new Date(now.getTime() - hours * 3_600_000).toISOString());
  if (filters.before) {
    params.set("before", filters.before.occurredAt);
    params.set("before_id", filters.before.id);
  }
  return `${AUDIT_PATH}?${params.toString()}`;
}

function Cell({ words }: { words: Words }) {
  return (
    <>
      {words.text}
      {words.alertTitle && <AlertTitle title={words.alertTitle} />}
      {words.code && (
        <Box component="code" sx={{ fontFamily: "monospace" }}>
          {words.text ? ` ${words.code}` : words.code}
        </Box>
      )}
    </>
  );
}

type View =
  | { kind: "loading" }
  | { kind: "signedOut" }
  | { kind: "refused" }
  | { kind: "error" }
  | {
      kind: "ok";
      entries: AuditEntry[];
      more: boolean;
      loadingOlder: boolean;
      olderFailed: boolean;
    };

/** Switch web → Hosted → Audit log (W5, p14). Read-only: Core has no route
 *  that changes or deletes an entry. */
export default function AuditTab() {
  const { operator, refreshKey } = useHosted();
  const [action, setAction] = useState("");
  const [idDraft, setIdDraft] = useState("");
  const [id, setId] = useState("");
  const [time, setTime] = useState("7d");
  const [view, setView] = useState<View>({ kind: "loading" });

  // A "Load older" still in flight when the filters change or the shell
  // refreshes is abandoned, so the old filter's rows never join the new view.
  const older = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    older.current?.abort();
    setView({ kind: "loading" });
    readOperatorRoute(auditQuery({ action, id, time }), parseEntries, controller.signal)
      .then((read) => {
        if (read.kind !== "ok") return setView({ kind: read.kind });
        setView({
          kind: "ok",
          entries: read.body,
          more: read.body.length >= PAGE_SIZE,
          loadingOlder: false,
          olderFailed: false,
        });
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      older.current?.abort();
    };
  }, [action, id, time, refreshKey]);

  const rows = useMemo(
    () => (view.kind === "ok" ? buildRows(view.entries, operator.id) : []),
    [view, operator.id],
  );

  async function loadOlder() {
    if (view.kind !== "ok" || view.entries.length === 0) return;
    const last = view.entries[view.entries.length - 1];
    const controller = new AbortController();
    older.current?.abort();
    older.current = controller;
    setView({ ...view, loadingOlder: true, olderFailed: false });
    let read;
    try {
      read = await readOperatorRoute(
        auditQuery({ action, id, time, before: { occurredAt: last.occurredAt, id: last.id } }),
        parseEntries,
        controller.signal,
      );
    } catch {
      return;
    }
    if (controller.signal.aborted) return;
    if (read.kind === "refused" || read.kind === "signedOut") {
      return setView({ kind: read.kind });
    }
    if (read.kind === "error") {
      return setView({ ...view, loadingOlder: false, olderFailed: true });
    }
    const seen = new Set(view.entries.map((e) => e.id));
    setView({
      kind: "ok",
      entries: [...view.entries, ...read.body.filter((e) => !seen.has(e.id))],
      more: read.body.length >= PAGE_SIZE,
      loadingOlder: false,
      olderFailed: false,
    });
  }

  useSignedOut(view.kind === "signedOut");

  if (view.kind === "refused") return <HostedRefusal />;

  return (
    <Stack spacing={2} sx={{ py: 1 }}>
      {/* The three filters on one row, a third each, stacking only on a narrow
          screen (designer's fix list, item 10). */}
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", md: "repeat(3, minmax(0, 1fr))" },
          gap: 1.5,
        }}
      >
        <TextField
          select
          size="small"
          label="Action"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          // "Any action" is the empty value, which a select otherwise shows as blank.
          slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }}
          fullWidth
        >
          <MenuItem value="">{ANY_ACTION}</MenuItem>
          {FILTER_ACTIONS.map((code) => (
            <MenuItem key={code} value={code}>
              {ACTION_WORDS[code]}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          size="small"
          label="Id"
          placeholder={ID_PLACEHOLDER}
          value={idDraft}
          slotProps={{ htmlInput: { maxLength: MAX_ID_FILTER } }}
          onChange={(e) => setIdDraft(e.target.value)}
          onBlur={() => setId(idDraft.trim())}
          onKeyDown={(e) => {
            if (e.key === "Enter") setId(idDraft.trim());
          }}
          fullWidth
        />
        <TextField
          select
          size="small"
          label="Time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          fullWidth
        >
          {TIME_FILTERS.map((t) => (
            <MenuItem key={t.value} value={t.value}>
              {t.label}
            </MenuItem>
          ))}
        </TextField>
      </Box>

      {(view.kind === "loading" || view.kind === "signedOut") && (
        <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
          <CircularProgress size={28} aria-label="Loading" />
        </Box>
      )}
      {view.kind === "error" && (
        <Typography role="alert" color="error">
          {LOAD_ERROR}
        </Typography>
      )}
      {view.kind === "ok" && rows.length === 0 && (
        <Typography color="text.secondary">{EMPTY}</Typography>
      )}
      {view.kind === "ok" && rows.length > 0 && (
        <Table size="small" aria-label="Audit log">
          <TableHead>
            <TableRow>
              <TableCell>When</TableCell>
              <TableCell>Who</TableCell>
              <TableCell>Action</TableCell>
              <TableCell>On</TableCell>
              <TableCell>Reason</TableCell>
              <TableCell>Result</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{row.when}</TableCell>
                <TableCell>{row.who}</TableCell>
                <TableCell>
                  <Cell words={row.action} />
                </TableCell>
                <TableCell>
                  {row.on === null ? (
                    NO_VALUE
                  ) : (
                    <Box component="code" title={row.on} sx={{ fontFamily: "monospace" }}>
                      {shortId(row.on)}
                    </Box>
                  )}
                </TableCell>
                <TableCell sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {row.reason}
                </TableCell>
                <TableCell>
                  <Cell words={row.result} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {view.kind === "ok" && view.olderFailed && (
        <Typography role="alert" color="error">
          {LOAD_ERROR}
        </Typography>
      )}
      {view.kind === "ok" && view.more && (
        <Box>
          <Button onClick={loadOlder} disabled={view.loadingOlder}>
            {LOAD_OLDER}
          </Button>
        </Box>
      )}
    </Stack>
  );
}
