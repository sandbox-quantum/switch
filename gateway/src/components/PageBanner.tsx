import InfoOutlined from "@mui/icons-material/InfoOutlined";
import WarningAmberOutlined from "@mui/icons-material/WarningAmberOutlined";
import { Alert } from "@mui/material";
import type { ReactNode } from "react";

const TONES = {
  warning: {
    severity: "warning",
    icon: <WarningAmberOutlined fontSize="small" />,
    iconColor: "var(--hoot-warning)",
    borderColor: "color-mix(in oklch, var(--hoot-warning) 40%, transparent)",
    backgroundColor: "color-mix(in oklch, var(--hoot-warning) 14%, transparent)",
  },
  neutral: {
    severity: "info",
    icon: <InfoOutlined fontSize="small" />,
    iconColor: "var(--hoot-muted-foreground)",
    borderColor: "var(--hoot-border)",
    backgroundColor: "var(--hoot-muted)",
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
  const { severity, icon, iconColor, borderColor, backgroundColor } = TONES[tone];
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
        borderColor,
        backgroundColor,
        color: "text.primary",
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
