import type { ReactNode } from "react";
import { Navigate, useLocation, useParams } from "react-router";
import { useAuth } from "../data/AuthContext";
import type { Rule } from "../data/capabilities";
import { NoAccessPage } from "./StatusPages";

/** Renders `children` only when `access` allows it for the signed-in person.
 * The server refuses the page's requests either way; this keeps the page from
 * loading into a column of errors, and says why. */
export function Guarded({ access, children }: { access: Rule; children: ReactNode }) {
  const { capabilities } = useAuth();
  const answer = access(capabilities);
  return answer.allowed ? <>{children}</> : <NoAccessPage access={answer} />;
}

/** `to` with `:name` filled from this route's parameters, keeping the query
 * and the fragment, so a moved page's old links land on the same thing. What
 * the target names itself, a query parameter or a fragment, wins over what is
 * carried across. */
export function RedirectTo({ to }: { to: string }) {
  const params = useParams();
  const { search, hash } = useLocation();
  const filled = to.replace(/:([A-Za-z_]+)/g, (_, name: string) =>
    encodeURIComponent(params[name] ?? ""),
  );
  const target = new URL(filled, "http://dashboard.invalid");
  const query = new URLSearchParams(search);
  target.searchParams.forEach((value, key) => query.set(key, value));
  const merged = query.toString();
  return (
    <Navigate
      replace
      to={{
        pathname: target.pathname,
        search: merged === "" ? "" : `?${merged}`,
        hash: target.hash !== "" ? target.hash : hash,
      }}
    />
  );
}
