import { Box } from "@mui/material";
import { Suspense, lazy } from "react";

// Dev builds only. A production build reads `import.meta.env.DEV` as false and
// drops this import with it, and `scripts/check-no-dev-tools.mjs` fails the
// build if any of `src/dev/` is left in.
const DevRoleSwitcher = import.meta.env.DEV ? lazy(() => import("../dev/DevRoleSwitcher")) : null;

/** The dev role switcher, at the right end of the top bar. */
export function DevRoleSlot() {
  if (DevRoleSwitcher === null) return null;
  return (
    <Suspense fallback={null}>
      <DevRoleSwitcher />
    </Suspense>
  );
}

/** The same, for the signed-in screens that have no top bar (choosing a
 * workspace, creating one), where the top bar's right end would be. */
export function DevRoleCorner() {
  if (DevRoleSwitcher === null) return null;
  return (
    <Box
      sx={{
        position: "fixed",
        top: 0,
        right: 16,
        height: "var(--top-bar-height)",
        display: "flex",
        alignItems: "center",
        zIndex: "appBar",
      }}
    >
      <DevRoleSlot />
    </Box>
  );
}
