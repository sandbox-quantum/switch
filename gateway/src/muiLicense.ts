import { LicenseInfo } from "@mui/x-license";

/** The data grid is `@mui/x-data-grid-pro`, which needs a MUI X Pro licence key.
 *
 * The key is injected at BUILD time from `VITE_MUI_X_LICENSE_KEY` and is never
 * committed — this repository cuts the open-source release artifacts, so a key
 * in the tree would end up published. See `gateway/.env.example`.
 *
 * Without a key the grid still works but paints a "MUI X Missing license key"
 * watermark over every table, so say so rather than letting it look like a
 * rendering bug. */
export function registerMuiLicense(): void {
  const key = import.meta.env.VITE_MUI_X_LICENSE_KEY;

  if (!key) {
    console.warn(
      "VITE_MUI_X_LICENSE_KEY is not set — data grids will render with the MUI X " +
        "watermark. Set it in gateway/.env (see gateway/.env.example) and rebuild.",
    );
    return;
  }

  LicenseInfo.setLicenseKey(key);
}
