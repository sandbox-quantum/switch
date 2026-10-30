import {
  Alert,
  AlertTitle,
  Box,
  Button,
  CircularProgress,
  Stack,
  Typography,
} from "@mui/material";
import { Suspense, lazy, useCallback, useState } from "react";
import { useNavigate } from "react-router";
import { type ProvisionResult, createRoomFromYaml } from "../../data/api";

const YamlEditor = lazy(() => import("./YamlEditor"));

const PLACEHOLDER = `room:
  name: "Pilot – ACME"
  description: "Pilot room for ACME"
  instructions: "Be helpful."
  bridge: "Slack"                 # bridge display name; omit for internal-only
  channel_type: channel_public
  read_visibility: public
  write_visibility: public
  agents: [claude-code.my-project.alice]
  users: [alice]
  roles:
    - { name: manager, instructions: "You coordinate.", exclusive: true }
  references:
    - { name: "Existing Drive ref" }      # attach existing by name
    - type: github                        # define a new one inline
      name: "Project repo"
      description: "The repo"
      instructions: "Use for code."
      value: { urls: ["https://github.com/your-org/your-repo"] }
  docs:
    - name: "Onboarding"
      description: "How to get started"
      instructions: "Read first."
      content: |
        # Onboarding
        ...
`;

export default function RoomCreateYamlBody() {
  const navigate = useNavigate();
  const [yamlText, setYamlText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProvisionResult | null>(null);

  const handleSubmit = useCallback(async () => {
    if (!yamlText.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await createRoomFromYaml(yamlText);
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create room.");
    } finally {
      setSubmitting(false);
    }
  }, [yamlText]);

  if (result) {
    return (
      <Stack spacing={2}>
        <Alert severity="success">
          <AlertTitle>Room created: {result.room_name}</AlertTitle>
          <Typography variant="body2">
            {result.attached_reference_ids.length} reference(s) attached,{" "}
            {result.created_reference_ids.length} created,{" "}
            {result.created_document_ids.length} document(s),{" "}
            {result.role_names.length} role(s).
          </Typography>
        </Alert>
        {result.failed_attachments.length > 0 && (
          <Alert severity="warning">
            <AlertTitle>
              {result.failed_attachments.length} attachment(s) failed
            </AlertTitle>
            <Stack spacing={0.5}>
              {result.failed_attachments.map((f, i) => (
                <Typography key={i} variant="caption">
                  {f.kind}
                  {f.id ? ` (${f.id})` : ""}: {f.error}
                </Typography>
              ))}
            </Stack>
          </Alert>
        )}
        <Stack direction="row" spacing={1} justifyContent="flex-end">
          <Button onClick={() => navigate("/rooms")}>Back to rooms</Button>
          <Button
            variant="contained"
            onClick={() => navigate(`/rooms/${result.room_id}`)}
          >
            Open room
          </Button>
        </Stack>
      </Stack>
    );
  }

  return (
    <Stack spacing={2}>
      {error && <Alert severity="error">{error}</Alert>}
      <Suspense
        fallback={
          <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}>
            <CircularProgress />
          </Box>
        }
      >
        <YamlEditor
          value={yamlText}
          onChange={setYamlText}
          placeholder={PLACEHOLDER}
        />
      </Suspense>
      <Typography variant="caption" color="text.secondary">
        A single top-level 'room:' mapping. Agents and users must already exist;
        references can attach an existing one (by name or id) or define a new one
        inline.
      </Typography>
      <Stack direction="row" spacing={1} justifyContent="flex-end">
        <Button onClick={() => navigate("/rooms")} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={!yamlText.trim() || submitting}
          startIcon={submitting ? <CircularProgress size={16} /> : undefined}
        >
          Create
        </Button>
      </Stack>
    </Stack>
  );
}
