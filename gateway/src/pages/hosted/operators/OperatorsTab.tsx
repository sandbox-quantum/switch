import {
  Box,
  CircularProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import { formatDate } from "../../../theme/hootFormat";
import { useHosted } from "../HostedContext";
import HostedRefusal from "../HostedRefusal";
import {
  type OperatorRead,
  isRecord,
  readOperatorRoute,
  stringOrNull,
} from "../w5shared/operatorFetch";
import { useSignedOut } from "../w5shared/useSignedOut";

/** Core's operator list, by name (W5's own route, operators only). */
export const OPERATORS_PATH = "/gateway/shared-cloud/operators";

/** p20's words. */
export const HOW_WORDS: Record<string, string> = {
  server_settings: "Server settings",
};
export const YOU_SUFFIX = " (you)";
export const FOOTNOTE =
  "Read-only. Adding or removing an operator is done in Switch's server settings, and each change appears in the audit log.";
export const LOAD_ERROR = "Couldn't load operators. Reload the page to try again.";
export const NO_VALUE = "—";

export interface HostedOperatorRow {
  name: string;
  since: string | null;
  how: string;
  you: boolean;
}

/** Only rows in the shape Core sends are kept; anything else is dropped. */
export function parseOperators(raw: unknown): HostedOperatorRow[] | null {
  if (!Array.isArray(raw)) return null;
  const rows: HostedOperatorRow[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const name = stringOrNull(item.name);
    const how = stringOrNull(item.how);
    if (name === null || how === null) continue;
    rows.push({
      name,
      since: stringOrNull(item.since),
      how,
      you: item.you === true,
    });
  }
  return rows;
}

/** The app's usual date format (`formatDate`, as on the Members page),
 *  never the browser's own locale (copy doc `80d779cb`). */
export function sinceDate(iso: string | null): string {
  return formatDate(iso);
}

/** Switch web → Hosted → Operators (W5, p20). Read-only: grants happen in
 *  Core's server settings and are audited. */
export default function OperatorsTab() {
  const { refreshKey } = useHosted();
  const [read, setRead] = useState<OperatorRead<HostedOperatorRow[]> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    readOperatorRoute(OPERATORS_PATH, parseOperators, controller.signal)
      .then(setRead)
      .catch(() => undefined);
    return () => controller.abort();
  }, [refreshKey]);

  useSignedOut(read?.kind === "signedOut");

  if (read === null || read.kind === "signedOut") {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
        <CircularProgress size={28} aria-label="Loading" />
      </Box>
    );
  }
  if (read.kind === "refused") return <HostedRefusal />;
  if (read.kind === "error") {
    return (
      <Typography role="alert" color="error" sx={{ py: 2 }}>
        {LOAD_ERROR}
      </Typography>
    );
  }

  return (
    <Stack spacing={2} sx={{ py: 1 }}>
      <Table size="small" aria-label="Operators">
        <TableHead>
          <TableRow>
            <TableCell>Operator</TableCell>
            <TableCell>Since</TableCell>
            <TableCell>How</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {read.body.map((row, i) => (
            <TableRow key={`${row.name}-${i}`}>
              <TableCell>
                {row.name}
                {row.you ? YOU_SUFFIX : ""}
              </TableCell>
              <TableCell>{sinceDate(row.since)}</TableCell>
              <TableCell>{HOW_WORDS[row.how] ?? NO_VALUE}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Typography variant="body2" color="text.secondary">
        {FOOTNOTE}
      </Typography>
    </Stack>
  );
}
