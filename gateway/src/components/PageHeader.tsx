import { Box, Stack, type SxProps, type Theme } from "@mui/material";
import type { ReactNode } from "react";

/**
 * A page or section header: a title and its optional description on the
 * left, actions on the right — usually a button. Neither slot picks its own
 * typography; each page passes the heading and body text it already uses
 * (an `h5` for a page, `subtitle1` for a section inside one), so this only
 * supplies the row's layout.
 *
 * The text takes the room the actions leave and wraps within it, so the
 * actions stay at the right. Once the text would be narrower than about
 * 320px, the actions drop to their own line below it rather than wrapping
 * into it, clipping, or being pushed off the page. The actions are never
 * wider than the header: several wrap among themselves, onto as many lines as
 * the width needs, and each one stays on a single line of its own.
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
      <Box sx={{ flex: "1 1 320px", minWidth: 0 }}>
        {title}
        {description}
      </Box>
      {actions && (
        <Stack
          direction="row"
          flexWrap="wrap"
          sx={{
            gap: 1,
            flexShrink: 0,
            maxWidth: "100%",
            "& > *": { whiteSpace: "nowrap" },
          }}
        >
          {actions}
        </Stack>
      )}
    </Stack>
  );
}
