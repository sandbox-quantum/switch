import { Typography } from "@mui/material";

/** What every Hosted tab shows when Core answers 403: one fixed line, never
 *  the server's text. */
export default function HostedRefusal() {
  return (
    <Typography role="status" color="text.secondary" sx={{ py: 2 }}>
      Operators only
    </Typography>
  );
}
