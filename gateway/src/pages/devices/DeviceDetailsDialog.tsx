import {
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import type { ReactNode } from "react";
import type { WorkspaceDevice } from "../../data/management";
import { EM_DASH, absoluteTitle, formatRelative } from "../../theme/format";
import { connectionDetail, controllerHealth, providerProblem } from "./deviceHealth";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack spacing={0.5}>
      <Typography variant="subtitle2">{title}</Typography>
      {children}
    </Stack>
  );
}

/**
 * How a device is doing, as it last reported: its state, its
 * controller against the release Switch names, and each agent provider's
 * install and sign-in. Read-only; opened from the device's row.
 */
export default function DeviceDetailsDialog({
  device,
  open,
  providerLabel,
  onClose,
}: {
  device: WorkspaceDevice | null;
  open: boolean;
  providerLabel: (provider: string) => string;
  onClose: () => void;
}) {
  const controller = device === null ? null : controllerHealth(device);
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{device?.name}</DialogTitle>
      {device !== null && controller !== null && (
        <DialogContent>
          <Stack spacing={2.5}>
            {device.description && (
              <Typography variant="body2" color="text.secondary">
                {device.description}
              </Typography>
            )}
            <Section title="State">
              <Typography variant="body2">{connectionDetail(device)}</Typography>
            </Section>
            <Section title="Controller">
              <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <Typography variant="body2">{controller.running ?? EM_DASH}</Typography>
                {controller.problem !== null && (
                  <Chip size="small" variant="outlined" color={controller.problem.color} label={controller.problem.label} />
                )}
              </Stack>
              <Typography variant="body2" color="text.secondary">
                {controller.detail}
              </Typography>
            </Section>
            <Section title="Agent providers">
              {device.provider_reports.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  Not reported yet.
                </Typography>
              ) : (
                <Table size="small" aria-label={`Agent providers on ${device.name}`}>
                  <TableHead>
                    <TableRow>
                      <TableCell>Provider</TableCell>
                      <TableCell>Installed</TableCell>
                      <TableCell>Sign-in</TableCell>
                      <TableCell>Checked</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {device.provider_reports.map((report) => {
                      const problem = providerProblem(report);
                      return (
                        <TableRow key={report.provider}>
                          <TableCell>{providerLabel(report.provider)}</TableCell>
                          <TableCell>{report.installed ? (report.version ?? "Yes") : "No"}</TableCell>
                          <TableCell>
                            {!report.installed ? (
                              EM_DASH
                            ) : (
                              <Tooltip title={report.auth_problem ?? report.reason ?? ""}>
                                <Chip
                                  size="small"
                                  variant="outlined"
                                  color={problem === null ? "success" : "warning"}
                                  label={problem === null ? "signed in" : problem}
                                />
                              </Tooltip>
                            )}
                          </TableCell>
                          <TableCell>
                            <Tooltip title={absoluteTitle(report.checked_at)}>
                              <span>{formatRelative(report.checked_at)}</span>
                            </Tooltip>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </Section>
          </Stack>
        </DialogContent>
      )}
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
