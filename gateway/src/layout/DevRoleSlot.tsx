import { Box } from "@mui/material";
import { Suspense, lazy } from "react";
import { useAuth } from "../data/AuthContext";

// Dev builds only. A production build reads `import.meta.env.DEV` as false and
// drops this import with it, and `scripts/check-no-dev-tools.mjs` fails the
// build if any of `src/dev/` is left in.
const DevRoleSwitcher = import.meta.env.DEV ? lazy(() => import("../dev/DevRoleSwitcher")) : null;

/** The switcher where it shows: in a dev build, on a server running the new
 * layout (`gateway_v2`). Flags are read only for a signed-in session, so
 * signed out it is off, like every flag. */
function useDevRoleSwitcher(): typeof DevRoleSwitcher {
  const { capabilities } = useAuth();
  return capabilities.features.gateway_v2 ? DevRoleSwitcher : null;
}

/** The dev role switcher, at the right end of the top bar. */
export function DevRoleSlot() {
  const Switcher = useDevRoleSwitcher();
  if (Switcher === null) return null;
  return (
    <Suspense fallback={null}>
      <Switcher />
    </Suspense>
  );
}

/** The same, for the signed-in screens that have no top bar (choosing a
 * workspace, creating one), where the top bar's right end would be. */
export function DevRoleCorner() {
  if (useDevRoleSwitcher() === null) return null;
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
