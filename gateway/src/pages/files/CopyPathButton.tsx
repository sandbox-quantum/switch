import CheckOutlined from "@mui/icons-material/CheckOutlined";
import ContentCopyOutlined from "@mui/icons-material/ContentCopyOutlined";
import { Button, useMediaQuery, useTheme } from "@mui/material";
import { useEffect, useRef, useState } from "react";

/** Copy path's fixed words (the shared explorer spec, item 11). */
export const COPY_WORDS = {
  copy: "Copy path",
  copied: "Path copied",
  failed: "Couldn't copy the path",
} as const;

/** How long "Path copied" (or the refusal) shows before the button comes back. */
export const COPIED_MS = 2_000;

const screenReaderOnly = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
} as const;

/**
 * Copy path: copies the path within Your cloud files only ("web-frontend/src/app.ts"),
 * never anything about the box, and says "Path copied" with a tick for two
 * seconds. A clipboard the browser refuses never claims success. At phone
 * width the button is its icon alone until it has something to say.
 */
export default function CopyPathButton({ path }: { path: string }) {
  const [note, setNote] = useState<"copied" | "failed" | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const theme = useTheme();
  const phone = useMediaQuery(theme.breakpoints.down("sm"));

  const copy = async () => {
    let outcome: "copied" | "failed";
    try {
      await navigator.clipboard.writeText(path);
      outcome = "copied";
    } catch {
      outcome = "failed";
    }
    window.clearTimeout(timer.current);
    setNote(outcome);
    timer.current = window.setTimeout(() => setNote(null), COPIED_MS);
  };

  const words = note ? COPY_WORDS[note] : COPY_WORDS.copy;
  const iconOnly = phone && note === null;
  return (
    <>
      <Button
        size="small"
        variant="outlined"
        color={note === "failed" ? "error" : note === "copied" ? "success" : "primary"}
        startIcon={iconOnly ? undefined : note === "copied" ? <CheckOutlined /> : <ContentCopyOutlined />}
        aria-label={words}
        onClick={() => void copy()}
        sx={{ whiteSpace: "nowrap", minWidth: 0 }}
      >
        {iconOnly ? <ContentCopyOutlined fontSize="small" aria-hidden /> : words}
      </Button>
      {/* Said aloud as it changes, beside the button rather than inside it. */}
      <span role="status" style={screenReaderOnly}>
        {note ? COPY_WORDS[note] : ""}
      </span>
    </>
  );
}
