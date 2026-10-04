import ContentCopy from "@mui/icons-material/ContentCopy";
import DoneOutline from "@mui/icons-material/DoneOutline";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import { createEnrollmentCode, type EnrollmentCode, enrollCommand } from "../../data/management";
import { MONO_SX, formatDate } from "../../theme/hootFormat";

function CopyBlock({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1}
      sx={{ p: 1.5, borderRadius: 1, bgcolor: "action.hover" }}
    >
      <Typography component="code" sx={{ ...MONO_SX, flexGrow: 1, wordBreak: "break-all" }}>
        {text}
      </Typography>
      <Tooltip title={copied ? "Copied!" : label}>
        <IconButton size="small" aria-label={label} onClick={copy}>
          {copied ? <DoneOutline fontSize="small" color="success" /> : <ContentCopy fontSize="small" />}
        </IconButton>
      </Tooltip>
    </Stack>
  );
}

/**
 * Issues a one-time enrollment code and shows the command that enrolls a
 * machine's agents controller with it. The code is shown once: closing the
 * dialog discards it, and a new open issues a new one.
 */
export default function AddMachineDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [enrollment, setEnrollment] = useState<EnrollmentCode | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setEnrollment(null);
    setError(null);
    createEnrollmentCode()
      .then((issued) => {
        if (!cancelled) setEnrollment(issued);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Add a machine</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          Run the agents controller on the machine that should run your agents (a laptop, your
          own VM or a server). Enroll it once with the code below; it then runs whatever agents
          you place on it here.
        </DialogContentText>
        {error && <Alert severity="error">Could not issue an enrollment code: {error}</Alert>}
        {!error && !enrollment && <CircularProgress size={24} />}
        {enrollment && (
          <Stack spacing={2}>
            <Box>
              <Typography variant="subtitle2" gutterBottom>
                Enrollment command
              </Typography>
              {enrollment.server_url ? (
                <>
                  <CopyBlock
                    text={enrollCommand(enrollment.server_url, enrollment.code)}
                    label="Copy command"
                  />
                  <Typography variant="caption" color="text.secondary">
                    <code>--server</code> is this Switch's API address. If the machine reaches
                    Switch at a different address, change it to that one.
                  </Typography>
                </>
              ) : (
                <Alert severity="warning">
                  This server does not say where its Switch API is, so no enrollment command
                  can be shown. Set <code>GATEWAY_PUBLIC_URL</code> on the Switch server to its
                  API address, or enroll with{" "}
                  <code>switch-agent-controller enroll --server &lt;Switch API URL&gt; --code</code>{" "}
                  and the code below. This page's address is not it.
                </Alert>
              )}
            </Box>
            <Box>
              <Typography variant="subtitle2" gutterBottom>
                Code only
              </Typography>
              <CopyBlock text={enrollment.code} label="Copy code" />
            </Box>
            <Alert severity="info">
              Single use, valid until {formatDate(enrollment.expires_at)}. After enrolling, start
              it with <code>switch-agent-controller run</code>; the machine appears in the list
              once it reports.
            </Alert>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Done</Button>
      </DialogActions>
    </Dialog>
  );
}
