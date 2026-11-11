import InfoOutlined from "@mui/icons-material/InfoOutlined";
import WarningAmberOutlined from "@mui/icons-material/WarningAmberOutlined";
import { Alert } from "@mui/material";
import type { ReactNode } from "react";
import { statusEdge, statusTone } from "../theme/theme";

const TONES = {
  // The warning banner's own treatment, as on every warning in the dashboard.
  warning: {
    severity: "warning",
    icon: <WarningAmberOutlined fontSize="small" />,
    iconColor: "var(--mui-palette-warning-main)",
    borderColor: statusEdge("warning"),
    ...statusTone("warning"),
  },
  neutral: {
    severity: "info",
    icon: <InfoOutlined fontSize="small" />,
    iconColor: "var(--sw-muted-foreground)",
    borderColor: "var(--sw-border)",
    backgroundColor: "var(--sw-muted)",
    color: "var(--sw-foreground)",
  },
} as const;

/**
 * A condition on the whole page, full width above its content: a page that
 * is read-only for this viewer, a workspace with issues to fix. Not a chip
 * beside the heading, which would read as metadata about the heading.
 *
 * It is a status, not an alert: it is there when the page opens rather than
 * arriving in response to something, so screen readers are not interrupted.
 */
export default function PageBanner({
  tone,
  children,
  action,
}: {
  tone: keyof typeof TONES;
  children: ReactNode;
  /** A control at the banner's end, such as the link to where it is fixed. */
  action?: ReactNode;
}) {
  // The rest is the banner's surface: its fill, edge and ink, and in a tone
  // its dark-mode wash.
  const { severity, icon, iconColor, ...surface } = TONES[tone];
  return (
    <Alert
      severity={severity}
      variant="outlined"
      role="status"
      icon={icon}
      action={action}
      sx={{
        alignItems: "center",
        borderRadius: "6px",
        ...surface,
        fontSize: "0.875rem",
        fontWeight: 600,
        "& .MuiAlert-icon": { color: iconColor, py: 0 },
        "& .MuiAlert-message": { py: 0.75 },
        "& .MuiAlert-action": { py: 0 },
      }}
    >
      {children}
    </Alert>
  );
}
