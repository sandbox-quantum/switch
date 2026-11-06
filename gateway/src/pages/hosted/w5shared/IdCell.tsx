import CheckIcon from "@mui/icons-material/Check";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { Box, IconButton, Tooltip } from "@mui/material";
import { useEffect, useState } from "react";
import { MONO_SX } from "../../../theme/hootFormat";
import { groupedId } from "../hostedActions";

/** A keyed id cut to its prefix group and last four ("k1-6d2c…3ab2"): enough
 *  to scan a column by. Anything not shaped like a keyed id shows as it is. */
export function shortId(id: string): string {
  const match = /^([a-z0-9]+-)([0-9a-f]{9,})$/.exec(id);
  if (!match) return id;
  return `${match[1]}${match[2].slice(0, 4)}…${match[2].slice(-4)}`;
}

/** How long "Copied" stays before the button goes back to copy. */
export const COPIED_MS = 1500;

/**
 * The Hosted pages' one way to show an id: short in the cell, the full id
 * (grouped for reading) on hover, and a button that copies the exact id.
 * The id is text only, never markup. A browser that refuses the clipboard
 * says so on the button, and the id is still there to select by hand.
 */
export default function IdCell({ id, label = "id" }: { id: string; label?: string }) {
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const timer = window.setTimeout(() => setCopied(null), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async (event: React.MouseEvent) => {
    // Inside a clickable row: copying isn't opening the row.
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(id);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  };

  const hint =
    copied === "yes" ? "Copied" : copied === "failed" ? "Couldn't copy. Select the id instead." : `Copy ${label}`;
  return (
    <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}>
      <Tooltip title={groupedId(id)}>
        <Box component="span" sx={MONO_SX} aria-label={`${label} ${groupedId(id)}`}>
          {shortId(id)}
        </Box>
      </Tooltip>
      <Tooltip title={hint}>
        <IconButton size="small" aria-label={hint} onClick={(e) => void copy(e)}>
          {copied === "yes" ? (
            <CheckIcon fontSize="inherit" />
          ) : (
            <ContentCopyIcon fontSize="inherit" />
          )}
        </IconButton>
      </Tooltip>
    </Box>
  );
}
