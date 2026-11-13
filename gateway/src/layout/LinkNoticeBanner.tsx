import { Alert } from "@mui/material";
import { useAuth } from "../data/AuthContext";

/** Says so when a link named a workspace the page could not switch to, so
 * nobody takes what is shown for the workspace the link was for. */
export default function LinkNoticeBanner() {
  const { linkNotice, dismissLinkNotice } = useAuth();
  if (linkNotice === null) return null;
  return (
    <Alert severity="info" sx={{ mb: 2 }} onClose={dismissLinkNotice}>
      {linkNotice}
    </Alert>
  );
}
