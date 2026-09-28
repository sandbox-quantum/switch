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
 *  admin adds the bot by its handle and then posts the code. The handle is
 *  shown whole because Telegram's search does not find a bot by part of it.
 *  The link and code work once, for ten minutes, which is said here because a
 *  link that quietly stopped working looks exactly like one that never did. */
export default function ClaimChatDialog({ platform, claim, onClose }: Props) {
  const [copied, setCopied] = useState<string | null>(null);
  const command = claim ? `/connect ${claim.code}` : "";
  const handle = claim?.bot_handle ?? "";
  const name = titleCase(platform);

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(text);
  };

  const close = () => {
    setCopied(null);
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
              For a channel, open its Administrators, choose Add Admin, and
              search for the bot by its full username:
            </Typography>
            <Copyable
              text={handle}
              label="Copy the bot's username"
              copied={copied}
              onCopy={copy}
            />
            <Typography variant="body2">
              Keep its permission to post, save, then post this in the channel:
            </Typography>
            <Copyable
              text={command}
              label="Copy the command"
              copied={copied}
              onCopy={copy}
            />
            <Typography variant="body2" color="text.secondary">
              Agents can always post to the channel. For posts in the channel to
              reach agents, turn on Sign Messages and Show Authors&apos;
              Profiles in its settings, and post as yourself rather than as the
              channel.
            </Typography>
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

function Copyable({
  text,
  label,
  copied,
  onCopy,
}: {
  text: string;
  label: string;
  copied: string | null;
  onCopy: (text: string) => void;
}) {
  return (
    <Stack direction="row" alignItems="center" spacing={1}>
      <Box
        component="code"
        sx={{
          ...MONO_SX,
          px: 1,
          py: 0.5,
          borderRadius: 1,
          bgcolor: "action.hover",
        }}
      >
        {text}
      </Box>
      <Tooltip title={copied === text ? "Copied" : "Copy"}>
        <IconButton
          size="small"
          onClick={() => onCopy(text)}
          aria-label={label}
        >
          <ContentCopyOutlined fontSize="small" />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}
