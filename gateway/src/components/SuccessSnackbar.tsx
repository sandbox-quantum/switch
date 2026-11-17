import CheckOutlined from "@mui/icons-material/CheckOutlined";
import CloseOutlined from "@mui/icons-material/CloseOutlined";
import { IconButton, Snackbar, Stack } from "@mui/material";
import { useEffect, useState } from "react";

/**
 * What a page says when something it did worked: one dark line at the foot of
 * the window, centred, led by a tick, gone after a few seconds. A failure is
 * not said here: it stays on the page, where it can be read and acted on.
 *
 * `message` null closes it; the last message is kept while it fades out.
 */
export default function SuccessSnackbar({
  message,
  onClose,
}: {
  message: string | null;
  onClose: () => void;
}) {
  const [shown, setShown] = useState(message ?? "");
  useEffect(() => {
    if (message !== null) setShown(message);
  }, [message]);
  return (
    <Snackbar
      open={message !== null}
      autoHideDuration={5000}
      onClose={(_, reason) => {
        if (reason !== "clickaway") onClose();
      }}
      anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      message={
        <Stack direction="row" spacing={1.25} sx={{ alignItems: "center" }}>
          <CheckOutlined fontSize="small" sx={{ color: "success.light" }} aria-hidden />
          <span>{shown}</span>
        </Stack>
      }
      action={
        <IconButton size="small" color="inherit" aria-label="Dismiss notification" onClick={onClose}>
          <CloseOutlined fontSize="small" />
        </IconButton>
      }
    />
  );
}
