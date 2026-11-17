import { Box, Stack, type SxProps, type Theme } from "@mui/material";
import type { ReactNode } from "react";

/**
 * A page or section header: a title and its optional description on the
 * left, actions on the right — usually a button. Neither slot picks its own
 * typography; each page passes the heading and body text it already uses
 * (an `h5` for a page, `subtitle1` for a section inside one), so this only
 * supplies the row's layout.
 *
 * At a width where the text and actions no longer fit side by side, the
 * actions drop to their own line below the text rather than wrapping into
 * it, clipping, or being pushed off the page. Several actions wrap among
 * themselves on that line, and each one stays on a single line of its own.
 */
export default function PageHeader({
  title,
  description,
  actions,
  sx,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  sx?: SxProps<Theme>;
}) {
  return (
    <Stack direction="row" flexWrap="wrap" sx={{ gap: 2, ...sx }}>
      <Box sx={{ minWidth: 0 }}>
        {title}
        {description}
      </Box>
      {actions && (
        <Stack
          direction="row"
          flexWrap="wrap"
          sx={{ gap: 1, flexShrink: 0, "& > *": { whiteSpace: "nowrap" } }}
        >
          {actions}
        </Stack>
      )}
    </Stack>
  );
}
