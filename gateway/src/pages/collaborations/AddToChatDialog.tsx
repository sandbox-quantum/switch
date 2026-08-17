import OpenInNewOutlined from "@mui/icons-material/OpenInNewOutlined";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from "@mui/material";
import type { BridgeDetail } from "../../data/api";

interface Props {
  /** The bridge to add to a chat, or null when the dialog is closed. */
  bridge: BridgeDetail | null;
  onClose: () => void;
}

/** "Add this messaging app to a chat", for the bridges that have such a link.
 *
 *  Everything here comes from the bridge: the adapter decides which links exist
 *  and what each one does, and supplies a note for the kinds of chat no link can
 *  reach. The dialog knows nothing about any particular platform — a bridge with
 *  no links never opens it, because the row shows no button. */
export default function AddToChatDialog({ bridge, onClose }: Props) {
  const links = bridge?.install_links ?? [];

  return (
    <Dialog open={!!bridge} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Add {bridge?.display_name} to a chat</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 0.5 }}>
          {links.map((link) => (
            <Stack key={link.key} spacing={1} alignItems="flex-start">
              <Button
                variant="contained"
                startIcon={<OpenInNewOutlined />}
                href={link.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                {link.label}
              </Button>
              <Typography variant="body2" color="text.secondary">
                {link.description}
              </Typography>
            </Stack>
          ))}

          {bridge?.install_note && (
            <Alert severity="info" variant="outlined">
              {bridge.install_note}
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
