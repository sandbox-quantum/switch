import { createContext, useContext } from "react";

export interface HostedOperator {
  id: string;
  name: string;
}

export interface HostedState {
  /** The signed-in operator. Core still checks every operator route. */
  operator: HostedOperator;
  /** Core's `/shared-cloud/overview` answer, as JSON, from the shell's access
   *  check or the latest `refresh()`. Tabs check its shape before using it.
   *  Memory only. */
  overview: unknown;
  /** True when the latest `refresh()` failed for a reason other than 401 or
   *  403. `overview` then still holds the last good answer. */
  overviewStale: boolean;
  /** Bumped on every `refresh()`. */
  refreshKey: number;
  /** Fetches the overview again, and tells every tab (W6 calls it after an
   *  action, W4 on its 30-second timer). A 401 sends the person to sign in,
   *  and a 403 shows "Operators only", as on first load. */
  refresh: () => Promise<void>;
}

export const HostedContext = createContext<HostedState | null>(null);

/** For a Hosted tab: the operator, the shared overview, and refresh. */
export function useHosted(): HostedState {
  const ctx = useContext(HostedContext);
  if (ctx === null) {
    throw new Error("useHosted must be used inside the Hosted page");
  }
  return ctx;
}
