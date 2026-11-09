import { CircularProgress } from "@mui/material";
import { lazy, Suspense, type ReactNode } from "react";
import { useFeatureFlags, useHostedV2 } from "../data/hooks";
import { NotFoundPage } from "./StatusPages";

// Hosted agents v2's two pages, as entries in the route table. Core's flags
// gate them here rather than in a table rule. With v2 off (or the flags
// unreadable) each address shows main's not-found page, exactly as main does
// for an address it doesn't know. Nothing shows while the flags are read.
//
// Both pages load on first use, in chunks of their own, so the code a v1
// visitor downloads is main's: none of either page, nor the libraries only
// they use (charts, markdown, code highlighting).
const CloudFilesPage = lazy(() => import("../pages/files/CloudFilesPage"));
const HostedPage = lazy(() => import("../pages/hosted/HostedPage"));

/** A v2 page while its chunk loads. Only ever reached with v2 on. */
function V2Page({ children }: { children: ReactNode }) {
  return <Suspense fallback={<CircularProgress />}>{children}</Suspense>;
}

/** The Hosted pages are hosted agents v2's: with v2 off, or Core's flag
 * unreadable, `/hosted/*` is not found, as on main. */
export function HostedRoute() {
  const hostedV2 = useHostedV2();
  if (hostedV2 === null) return null;
  return hostedV2 ? (
    <V2Page>
      <HostedPage />
    </V2Page>
  ) : (
    <NotFoundPage />
  );
}

/** Your cloud files is hosted agents v2's, behind its own flag too: with
 * `hosted_v2` or `hosted_cloud_files` off, or Core's flags unreadable, `/files`
 * is not found, as on main. */
export function FilesRoute() {
  const flags = useFeatureFlags();
  if (flags.loading && flags.data === null) return null;
  const on = flags.data?.hosted_v2 === true && flags.data?.hosted_cloud_files === true;
  return on ? (
    <V2Page>
      <CloudFilesPage />
    </V2Page>
  ) : (
    <NotFoundPage />
  );
}
