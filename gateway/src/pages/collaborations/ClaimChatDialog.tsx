import ContentCopyOutlined from "@mui/icons-material/ContentCopyOutlined";
import OpenInNewOutlined from "@mui/icons-material/OpenInNewOutlined";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { useState } from "react";
import type { ChatClaim } from "../../data/api";
import { MONO_SX, titleCase } from "../../theme/hootFormat";

interface Props {
  platform: string;
  /** The claim to show, or null when the dialog is closed. */
  claim: ChatClaim | null;
  onClose: () => void;
}

/** Connecting a chat to a claim-based platform (Telegram).
 *
 *  Shown rather than navigated to, unlike an OAuth install: there is no
 *  consent screen to send the browser to, only a link that opens the
 *  platform's own chat picker, and a code for the one kind of chat the link
 *  cannot reach. A channel carries no state when a bot is added to it, so its
 *  admin adds the bot and then posts the code. Either works once, for ten
 *  minutes, which is said here because a link that quietly stopped working
 *  looks exactly like one that never did. */
export default function ClaimChatDialog({ platform, claim, onClose }: Props) {
  const [copied, setCopied] = useState(false);
  const command = claim ? `/connect ${claim.code}` : "";
  const name = titleCase(platform);

  const copy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
  };

  const close = () => {
    setCopied(false);
    onClose();
  };

  return (
    <Dialog open={!!claim} onClose={close} maxWidth="sm" fullWidth>
      <DialogTitle>Connect a {name} chat</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 0.5 }}>
          <Stack spacing={1} alignItems="flex-start">
            <Button
              variant="contained"
              startIcon={<OpenInNewOutlined />}
              href={claim?.url ?? ""}
              target="_blank"
              rel="noreferrer noopener"
            >
              Add to a {name} group
            </Button>
            <Typography variant="body2" color="text.secondary">
              Pick a group and confirm. The bot joins, Switch creates the
              group&apos;s room, and the bot says in the group that it is
              connected.
            </Typography>
          </Stack>

          <Stack spacing={1}>
            <Typography variant="body2">
              For a channel, add the bot as an administrator with permission to
              post, then post this in the channel:
            </Typography>
            <Stack direction="row" alignItems="center" spacing={1}>
              <Box
                component="code"
                sx={{ ...MONO_SX, px: 1, py: 0.5, borderRadius: 1, bgcolor: "action.hover" }}
              >
                {command}
              </Box>
              <Tooltip title={copied ? "Copied" : "Copy"}>
                <IconButton size="small" onClick={copy} aria-label="Copy the command">
                  <ContentCopyOutlined fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          </Stack>

          <Alert severity="info" variant="outlined">
            The link and the code work once, for ten minutes. Anyone who has
            them in that time can connect a chat to this organisation, so share
            them only with people who should.
          </Alert>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
