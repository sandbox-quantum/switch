import { Box } from "@mui/material";
import { Suspense, lazy } from "react";

// Dev builds only. A production build reads `import.meta.env.DEV` as false and
// drops this import with it, and `scripts/check-no-dev-tools.mjs` fails the
// build if any of `src/dev/` is left in.
const DevRoleSwitcher = import.meta.env.DEV ? lazy(() => import("../dev/DevRoleSwitcher")) : null;

/** The dev role switcher, in the top bar beside Docs. Nothing in a build. */
export function DevRoleSlot() {
  if (DevRoleSwitcher === null) return null;
  return (
    <Suspense fallback={null}>
      <DevRoleSwitcher />
    </Suspense>
  );
}

/** The same, for the screens that have no top bar (signing in, choosing a
 * workspace), where the top bar's right end would be. */
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
