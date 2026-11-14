import { Alert, Box, Button, CircularProgress, Stack, TextField, Typography } from "@mui/material";
import { useCallback, useState } from "react";
import ConfirmDialog from "../../../components/ConfirmDialog";
import InfoTip from "../../../components/InfoTip";
import RowActionsMenu from "../../../components/RowActionsMenu";
import {
  type OrganizationGuardrails as Guardrails,
  connectOrganizationGuardrails,
  disconnectOrganizationGuardrails,
  fetchOrganizationGuardrails,
} from "../../../data/api";
import { MONO_SX, formatDate } from "../../../theme/format";
import GuardrailPolicyCard from "../../guardrails/GuardrailPolicyCard";
import { useLoad } from "../../workspace/useLoad";

const EVERYWHERE =
  "Every workspace, every room, every agent, both directions. There is no per-workspace version.";

/** How short an API key Switch Trust could have issued, at the least: the
 * form waits for one at least this long rather than send a fragment. */
const MIN_KEY_LENGTH = 8;

/** The Switch Trust policy the organization checks every message in its
 * workspaces against: connecting one, with its policy ID and an API key,
 * checked with Switch Trust before it is kept; the policy once connected;
 * and disconnecting it. Its admins only, as the route table admits.
 *
 * `heading` says where it sits: as Organization settings › Guardrails in the
 * new layout, or as one section of today's organization page, the only
 * place to set guardrails while the new layout is off. */
export default function OrganizationGuardrails({
  organizationName,
  heading,
}: {
  organizationName: string;
  heading: "page" | "section";
}) {
  const load = useCallback(() => fetchOrganizationGuardrails(), []);
  const { data, error, loading, refetch } = useLoad(load);
  const [setting, setSetting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const connected = async (policy: Guardrails) => {
    setSetting(false);
    setNotice(`Switch Trust is connected${policy.policy_name ? ` with ${policy.policy_name}` : ""}.`);
    await refetch();
  };

  const disconnect = async () => {
    await disconnectOrganizationGuardrails();
    setNotice("Switch Trust is disconnected. Nothing is checked until a policy is connected.");
    await refetch();
  };

  const subtitle =
    data === null
      ? null
      : data.connected
        ? `Switch Trust checks every message in ${organizationName}${data.policy_name ? ` against ${data.policy_name}` : ""}.`
        : "Nothing is checked until Switch Trust is connected.";

  return (
    <Box>
      <Stack spacing={0.5} sx={{ mb: heading === "page" ? 3 : 1.5 }}>
        <Typography variant={heading === "page" ? "h5" : "h6"}>Guardrails</Typography>
        {subtitle !== null && (
          <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
            <Typography variant="body2" color="text.secondary">
              {subtitle}
            </Typography>
            <InfoTip>{EVERYWHERE}</InfoTip>
          </Stack>
        )}
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
      {notice !== null && (
        <Alert severity="info" onClose={() => setNotice(null)} sx={{ mb: 2 }}>
          {notice}
        </Alert>
      )}
      {loading ? (
        <CircularProgress />
      ) : data === null ? null : setting ? (
        <ConnectForm
          replacing={data.connected}
          onConnected={connected}
          onCancel={() => setSetting(false)}
        />
      ) : data.connected && data.policy_id !== null ? (
        <Stack spacing={1}>
          <GuardrailPolicyCard
            policyId={data.policy_id}
            policyName={data.policy_name}
            policyUrl={data.policy_url}
            actions={
              <RowActionsMenu
                label="Policy actions"
                tabIndex={0}
                actions={[
                  { label: "Connect another policy", onClick: () => setSetting(true) },
                  { label: "Disconnect", onClick: () => setDisconnecting(true), destructive: true },
                ]}
              />
            }
          />
          <Typography variant="caption" color="text.secondary">
            {data.api_key_last4 !== null ? (
              <>
                API key ending{" "}
                <Box component="span" sx={MONO_SX}>
                  {data.api_key_last4}
                </Box>
              </>
            ) : (
              "The API key kept for it can't be read any more. Connect the policy again with its key."
            )}
            {data.connected_at !== null &&
              ` · Connected${data.connected_by_name ? ` by ${data.connected_by_name}` : ""} on ${formatDate(data.connected_at)}`}
          </Typography>
        </Stack>
      ) : (
        <Button variant="contained" onClick={() => setSetting(true)}>
          Set up
        </Button>
      )}
      <ConfirmDialog
        open={disconnecting}
        title="Disconnect Switch Trust?"
        description={`Every check stops in ${organizationName}: messages in its workspaces are sent unchecked until a policy is connected again.`}
        confirmLabel="Disconnect"
        tone="destructive"
        onConfirm={disconnect}
        onClose={() => setDisconnecting(false)}
      />
    </Box>
  );
}

/** The policy ID and API key, both from Switch Trust. Its address is not
 * asked for: it is Switch's own. */
function ConnectForm({
  replacing,
  onConnected,
  onCancel,
}: {
  replacing: boolean;
  onConnected: (policy: Guardrails) => Promise<void>;
  onCancel: () => void;
}) {
  const [policyId, setPolicyId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = policyId.trim() !== "" && apiKey.trim().length >= MIN_KEY_LENGTH;

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConnected(await connectOrganizationGuardrails(policyId.trim(), apiKey.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Stack
      component="form"
      spacing={2}
      sx={{ maxWidth: 420 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !busy) void connect();
      }}
    >
      {replacing && (
        <Alert severity="info">
          The policy connected now stays in use until Switch Trust accepts this one.
        </Alert>
      )}
      <TextField
        label="Guardrail policy ID"
        value={policyId}
        onChange={(e) => setPolicyId(e.target.value)}
        helperText="Copy it from your policy on Switch Trust."
        autoFocus
        autoComplete="off"
        slotProps={{ htmlInput: { spellCheck: false, style: { fontFamily: "monospace" } } }}
      />
      <TextField
        label="API key"
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        autoComplete="new-password"
        slotProps={{ htmlInput: { spellCheck: false, style: { fontFamily: "monospace" } } }}
      />
      {error && <Alert severity="error">{error}</Alert>}
      <Stack direction="row" spacing={1}>
        <Button type="submit" variant="contained" disabled={!valid} loading={busy}>
          Connect
        </Button>
        <Button variant="outlined" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </Stack>
    </Stack>
  );
}
