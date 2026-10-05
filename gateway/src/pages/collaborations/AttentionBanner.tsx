import { Alert, Button, CircularProgress } from "@mui/material";

interface Props {
  displayName: string;
  message: string;
  // Only a connection on this deployment's own app (the distributed Teams
  // app) can be re-approved from here — a registered app's credentials are
  // the operator's to fix, not a button Switch can click for them.
  canApproveAgain: boolean;
  approving: boolean;
  onApproveAgain: () => void;
}

/** Something only the platform's side can fix, found on a live connection —
 *  an approval withdrawn, the app blocked by an organisation admin. Shown for
 *  any bridge type: the message is the adapter's own words, and this component
 *  knows nothing about any particular platform. */
export default function AttentionBanner({
  displayName,
  message,
  canApproveAgain,
  approving,
  onApproveAgain,
}: Props) {
  return (
    <Alert
      severity="warning"
      sx={{ mb: 1 }}
      action={
        canApproveAgain ? (
          <Button
            color="inherit"
            size="small"
            onClick={onApproveAgain}
            disabled={approving}
            startIcon={approving ? <CircularProgress size={14} /> : undefined}
          >
            Approve again
          </Button>
        ) : undefined
      }
    >
      <strong>{displayName}:</strong> {message}
    </Alert>
  );
}
