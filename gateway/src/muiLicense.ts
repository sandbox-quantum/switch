import { LicenseInfo } from "@mui/x-license";
import { runtimeConfig } from "./runtimeConfig";

/** The data grid is `@mui/x-data-grid-pro`, which needs a MUI X Pro licence key.
 *
 * A MUI licence cannot be redistributed, so the published gateway image never
 * carries one: every organisation deploying Switch supplies its own. The key is
 * therefore RUNTIME configuration (`MUI_X_LICENSE_KEY` on the container, surfaced
 * through `config.js`), not something baked into the bundle. `VITE_MUI_X_LICENSE_KEY`
 * is honoured as a fallback purely so the Vite dev server can pick it up from
 * `gateway/.env`.
 *
 * Without a key the grid still works but paints a "MUI X Missing license key"
 * watermark over every table, so say so rather than letting it look like a
 * rendering bug. */
export function registerMuiLicense(): void {
  const key = runtimeConfig().muiXLicenseKey || import.meta.env.VITE_MUI_X_LICENSE_KEY;

  if (!key) {
    console.warn(
      "No MUI X licence key configured — data grids will render with the MUI X " +
        "watermark. Set MUI_X_LICENSE_KEY on the gateway container (Helm: " +
        "gateway.muiLicenseKey), or VITE_MUI_X_LICENSE_KEY in gateway/.env for local dev.",
    );
    return;
  }

  LicenseInfo.setLicenseKey(key);
}
