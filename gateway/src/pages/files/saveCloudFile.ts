import { readCloudFile } from "../../data/cloudFiles";
import { DOWNLOAD_REVOKE_MS, safeSuggestedName } from "./cloudFiles";

/**
 * Save one cloud file to the person's computer: read through the existing
 * cloud-files route (its size cap and errors apply), handed over as an
 * opaque download, never opened as a page. The preview's Download and a
 * row's quick action both use this, so they behave the same.
 */
export async function saveCloudFile(path: string, name: string): Promise<void> {
  const bytes = await readCloudFile(path);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = safeSuggestedName(name, "file");
  link.rel = "noopener";
  link.click();
  // Released a moment later: some Safari versions cancel a download whose
  // address is revoked straight after the click.
  window.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_REVOKE_MS);
}
