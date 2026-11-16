import { Alert, Box, Button, Chip, CircularProgress, Stack, TextField, Typography } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import {
  type BridgeDetail,
  claimBridgeIdentity,
  type DirectoryPerson,
  type DirectorySearch,
  type LinkCode,
  type PendingIdentity,
  searchBridgeDirectory,
} from "../../data/api";
import { pluralize } from "../../theme/format";
import { afterClaim, type LinkTarget } from "./chatAccounts";
import { useMyAccounts } from "./useMyAccounts";

/** How long to wait after the last keystroke before asking. Every search is a
 * live call out to the platform, so this spares its rate limits as much as
 * Switch's. */
export const SEARCH_DEBOUNCE_MS = 300;

/** Below this a directory returns most of the workspace, which is neither
 * useful to scan nor cheap to fetch. */
export const MIN_QUERY_LENGTH = 2;

type Result =
  | { state: "idle" }
  | { state: "searching"; query: string }
  | { state: "found"; query: string; search: DirectorySearch }
  | { state: "failed"; query: string; message: string };

/**
 * Find yourself in a messaging app and say which account is you.
 *
 * The search goes to the platform's own directory, so someone can find
 * themselves in a workspace they have never posted in. Where the platform has
 * none (Telegram), Switch answers from the accounts it has seen, and says so
 * beside the results rather than presenting a partial list as a whole one.
 *
 * Nothing is refused because someone else holds the account: several people
 * may be recognised on one, and the others are named so a shared or
 * misidentified account is visible.
 */
export default function AccountSearch({
  app,
  currentUserId,
  onBusy,
  onAnnounce,
  onLinked,
  onConfirm,
}: {
  app: BridgeDetail;
  currentUserId: string | null;
  onBusy: (busy: boolean) => void;
  /** What a screen reader should hear as the search runs and answers, for
   *  the dialog's one live region: the list itself appears silently. */
  onAnnounce: (text: string) => void;
  /** The claim came back linked and confirmed: nothing to wait for. */
  onLinked: (username: string) => void;
  /** A link that waits on a code: one just made, one already waiting, or an
   *  older one to confirm. `code` is the one a claim came back with, else
   *  null. */
  onConfirm: (target: LinkTarget, code: LinkCode | null) => void;
}) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<Result>({ state: "idle" });
  const [claiming, setClaiming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  // Your links waiting for a code, read afresh each time the search opens:
  // coming back to it from a code just cancelled, a list read before would
  // still offer that link's code. The directory lists only links that count,
  // so these are matched to its people here.
  const { pending } = useMyAccounts(null);

  const announcement = searchAnnouncement(result);
  useEffect(() => {
    onAnnounce(announcement);
  }, [announcement, onAnnounce]);

  const query = text.trim();
  useEffect(() => {
    // Bumped here too, so a search already in flight for a longer query does
    // not land under a field that no longer reads it.
    const asked = ++latest.current;
    if (query.length < MIN_QUERY_LENGTH) {
      setResult({ state: "idle" });
      return;
    }
    const timer = setTimeout(() => {
      setResult({ state: "searching", query });
      searchBridgeDirectory(app.bridge_id, query).then(
        (search) => asked === latest.current && setResult({ state: "found", query, search }),
        (e: unknown) =>
          asked === latest.current &&
          setResult({
            state: "failed",
            query,
            message: e instanceof Error ? e.message : "Could not search.",
          }),
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [app.bridge_id, query]);

  const claim = async (person: DirectoryPerson) => {
    setClaiming(person.external_user_id);
    onBusy(true);
    setError(null);
    try {
      const next = afterClaim(await claimBridgeIdentity(app.bridge_id, person));
      if (next.kind === "linked") onLinked(person.username);
      else onConfirm(next.target, next.code);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not link this account.");
    } finally {
      setClaiming(null);
      onBusy(false);
    }
  };

  return (
    <Stack spacing={2}>
      <TextField
        label={`Search ${app.display_name}`}
        placeholder="Your name, handle or email"
        value={text}
        autoFocus
        fullWidth
        slotProps={{ htmlInput: { spellCheck: false } }}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
      />
      <Results
        app={app}
        result={result}
        currentUserId={currentUserId}
        pending={(pending ?? []).filter((p) => p.bridge_id === app.bridge_id)}
        claiming={claiming}
        onClaim={(person) => void claim(person)}
        onConfirm={(target) => onConfirm(target, null)}
      />
      {error !== null && (
        <Alert severity="error" sx={{ overflowWrap: "anywhere" }}>
          {error}
        </Alert>
      )}
    </Stack>
  );
}

/** What a screen reader hears as a search runs and answers. */
function searchAnnouncement(result: Result): string {
  switch (result.state) {
    case "idle":
      return "";
    case "searching":
      return "Searching…";
    case "failed":
      return "";
    case "found":
      return result.search.users.length === 0
        ? "Nobody matches."
        : `${pluralize(result.search.users.length, "person", "people")} found.`;
  }
}

function Results({
  app,
  result,
  currentUserId,
  pending,
  claiming,
  onClaim,
  onConfirm,
}: {
  app: BridgeDetail;
  result: Result;
  currentUserId: string | null;
  pending: readonly PendingIdentity[];
  claiming: string | null;
  onClaim: (person: DirectoryPerson) => void;
  onConfirm: (target: LinkTarget) => void;
}) {
  if (result.state === "idle") {
    return (
      <Typography variant="body2" color="text.secondary">
        {app.directory_search_supported
          ? `Type at least ${MIN_QUERY_LENGTH} characters to search ${app.display_name}'s directory.`
          : `Type at least ${MIN_QUERY_LENGTH} characters to search the people Switch has seen in ${app.display_name}. It has no directory, so you appear here once you have sent a message in a chat connected to Switch.`}
      </Typography>
    );
  }
  if (result.state === "searching") {
    return (
      <Stack direction="row" spacing={1} alignItems="center">
        <CircularProgress size={14} aria-label="Searching" />
        <Typography variant="body2" color="text.secondary">
          Searching…
        </Typography>
      </Stack>
    );
  }
  if (result.state === "failed") {
    return (
      <Alert severity="error" sx={{ overflowWrap: "anywhere" }}>
        {result.message}
      </Alert>
    );
  }

  const { search, query } = result;
  // The platform could not be searched and the answer is only the accounts
  // Switch has seen: real, but not complete, so it is captioned.
  const narrowed = search.note !== null && (
    <Alert severity="info" variant="outlined">
      {search.note}
    </Alert>
  );
  if (search.users.length === 0) {
    return (
      <Stack spacing={1}>
        {narrowed}
        <Typography variant="body2" color="text.secondary">
          {search.source === "known"
            ? `Nobody Switch has seen in ${app.display_name} matches “${query}”.`
            : `Nobody in ${app.display_name} matches “${query}”.`}
        </Typography>
      </Stack>
    );
  }

  return (
    <Stack spacing={1}>
      {narrowed}
      <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, maxHeight: 280, overflowY: "auto" }}>
        {search.users.map((person) => {
          const mine = person.claimed_by.find((c) => c.user_id === currentUserId) ?? null;
          const others = person.claimed_by.filter((c) => c.user_id !== currentUserId);
          const waiting =
            mine === null
              ? (pending.find((p) => p.external_user_id === person.external_user_id) ?? null)
              : null;
          const rowId = person.known_external_user_id;
          return (
            <Box
              component="li"
              key={person.external_user_id}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 2,
                px: 1.5,
                py: 1,
                mb: 1,
                border: "1px solid var(--sw-border)",
                borderRadius: "10px",
              }}
            >
              <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
                  {person.display_name}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap component="div">
                  @{handleOf(person)}
                  {person.email ? ` · ${person.email}` : ""}
                </Typography>
                {others.length > 0 && (
                  <Typography variant="caption" color="text.secondary" noWrap component="div">
                    Also linked to {others.map((c) => c.user_name).join(", ")}
                  </Typography>
                )}
              </Box>
              {mine !== null ? (
                <Stack direction="row" spacing={1} alignItems="center" sx={{ flexShrink: 0 }}>
                  <Chip size="small" label={mine.verified ? "Linked to you" : "Linked, not confirmed"} />
                  {!mine.verified && rowId !== null && (
                    <Button
                      size="small"
                      variant="outlined"
                      aria-label={`Confirm @${handleOf(person)}`}
                      disabled={claiming !== null}
                      onClick={() =>
                        onConfirm({ identityId: rowId, username: person.username, kind: "unverified" })
                      }
                    >
                      Confirm
                    </Button>
                  )}
                </Stack>
              ) : waiting !== null ? (
                <Stack direction="row" spacing={1} alignItems="center" sx={{ flexShrink: 0 }}>
                  <Chip size="small" label="Waiting for confirmation" />
                  <Button
                    size="small"
                    variant="outlined"
                    aria-label={`Finish linking @${handleOf(person)}`}
                    disabled={claiming !== null}
                    onClick={() =>
                      onConfirm({
                        identityId: waiting.id,
                        username: waiting.external_username,
                        kind: "pending",
                      })
                    }
                  >
                    Finish linking
                  </Button>
                </Stack>
              ) : (
                <Button
                  size="small"
                  variant="contained"
                  aria-label={`This is me: ${person.display_name}, @${handleOf(person)}`}
                  disabled={claiming !== null}
                  loading={claiming === person.external_user_id}
                  onClick={() => onClaim(person)}
                  sx={{ flexShrink: 0 }}
                >
                  This is me
                </Button>
              )}
            </Box>
          );
        })}
      </Box>
    </Stack>
  );
}

/** A person's username without the sigil some platforms report it with. */
function handleOf(person: DirectoryPerson): string {
  return person.username.replace(/^@/, "");
}
