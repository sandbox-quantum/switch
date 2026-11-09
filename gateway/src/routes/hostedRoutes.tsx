import { CircularProgress } from "@mui/material";
import { Navigate } from "react-router";
import { useFeatureFlags, useHostedV2 } from "../data/hooks";
import CloudFilesPage from "../pages/files/CloudFilesPage";
import HostedPage from "../pages/hosted/HostedPage";

// Hosted agents v2's two pages, as entries in the route table. Core's flags
// gate them here rather than in a table rule, so that with v2 off (or the flags
// unreadable) each address goes home, as it did before the route table, rather
// than showing a "not turned on" page that names hosted agents v2.

/** The Hosted pages are hosted agents v2's: with v2 off, or Core's flag
 * unreadable, `/hosted/*` goes home rather than showing them. */
export function HostedRoute() {
  const hostedV2 = useHostedV2();
  if (hostedV2 === null) return <CircularProgress />;
  return hostedV2 ? <HostedPage /> : <Navigate to="/" replace />;
}

/** Your cloud files is hosted agents v2's, behind its own flag too: with
 * `hosted_v2` or `hosted_cloud_files` off, or Core's flags unreadable, `/files`
 * goes home, as `/hosted/*` does, rather than showing any of its page. */
export function FilesRoute() {
  const flags = useFeatureFlags();
  if (flags.loading && flags.data === null) return <CircularProgress />;
  const on = flags.data?.hosted_v2 === true && flags.data?.hosted_cloud_files === true;
  return on ? <CloudFilesPage /> : <Navigate to="/" replace />;
}
