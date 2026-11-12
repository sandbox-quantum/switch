import ContentCopy from "@mui/icons-material/ContentCopy";
import OpenInNew from "@mui/icons-material/OpenInNew";
import { Box, Card, CardActions, CardContent, IconButton, Link, Stack, Tooltip, Typography } from "@mui/material";
import { type ReactNode, useState } from "react";
import { MONO_SX } from "../../theme/format";

/**
 * The Switch Trust policy that checks messages, as a card: its ID, to copy,
 * and where to see it on Switch Trust. Switch reads no more of a policy than
 * its ID, so its name and detectors are on Switch Trust only.
 *
 * `actions` go in the card's corner: the organization's page puts
 * Disconnect there; the workspace's, which only reads the policy, nothing.
 */
export default function GuardrailPolicyCard({
  policyId,
  policyUrl,
  actions,
}: {
  policyId: string;
  /** Null when the policy is on a Switch Trust Switch can't link into. */
  policyUrl: string | null;
  actions?: ReactNode;
}) {
  const [copied, setCopied] = useState<"yes" | "refused" | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(policyId);
      setCopied("yes");
    } catch {
      setCopied("refused");
    }
  };

  return (
    <Card variant="outlined" sx={{ borderRadius: "16px", maxWidth: 640 }}>
      <CardContent>
        <Stack direction="row" spacing={2} sx={{ alignItems: "flex-start", justifyContent: "space-between" }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
              Switch Trust policy
            </Typography>
            <Stack direction="row" spacing={0.5} sx={{ alignItems: "center", mt: 0.5 }}>
              <Typography component="span" sx={{ ...MONO_SX, wordBreak: "break-all" }}>
                {policyId}
              </Typography>
              <Tooltip title="Copy the policy ID">
                <IconButton size="small" aria-label="Copy the policy ID" onClick={() => void copy()}>
                  <ContentCopy fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
            <Typography variant="caption" color="text.secondary" role="status" sx={{ display: "block" }}>
              {copied === "yes"
                ? "Copied the policy ID."
                : copied === "refused"
                  ? "Your browser blocked the clipboard. Select the ID and copy it."
                  : ""}
            </Typography>
          </Box>
          {actions}
        </Stack>
        {policyUrl && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Its detectors for user and assistant messages are listed on Switch Trust.
          </Typography>
        )}
      </CardContent>
      {policyUrl && (
        <CardActions sx={{ borderTop: "1px solid var(--sw-border)", px: 2 }}>
          <Link href={policyUrl} target="_blank" rel="noopener noreferrer" underline="hover">
            <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
              <span>View on Switch Trust</span>
              <OpenInNew aria-hidden sx={{ fontSize: 16 }} />
            </Stack>
          </Link>
        </CardActions>
      )}
    </Card>
  );
}
