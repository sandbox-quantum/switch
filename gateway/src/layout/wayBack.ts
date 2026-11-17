import { useRef } from "react";
import { type Location, NavigationType, useLocation, useNavigationType } from "react-router";
import { underAreaOutsideWorkspace } from "../routes/routeTable";

interface Entry {
  key: string;
  pathname: string;
  href: string;
}

/** The history entries this tab has visited in the app, as far as it has
 * seen them, and which one is current. */
export interface Trail {
  entries: Entry[];
  index: number;
}

export const EMPTY_TRAIL: Trail = { entries: [], index: -1 };

/** `trail` once the router has moved to `location` by `type`. Following the
 * same location twice changes nothing. A step back to an entry it never saw,
 * from before the app loaded, starts the trail again there. */
export function follow(trail: Trail, location: Location, type: NavigationType): Trail {
  const entry = {
    key: location.key,
    pathname: location.pathname,
    href: `${location.pathname}${location.search}${location.hash}`,
  };
  const current = trail.entries[trail.index];
  if (current === undefined) return { entries: [entry], index: 0 };
  if (current.key === entry.key) return trail;
  if (type === NavigationType.Push) {
    return { entries: [...trail.entries.slice(0, trail.index + 1), entry], index: trail.index + 1 };
  }
  if (type === NavigationType.Replace) {
    return { entries: trail.entries.map((e, i) => (i === trail.index ? entry : e)), index: trail.index };
  }
  const index = trail.entries.findIndex((e) => e.key === entry.key);
  return index === -1 ? { entries: [entry], index: 0 } : { entries: trail.entries, index };
}

/** The last page in the workspace before the current one: where it is, and
 * how many steps back in history. Null when the trail holds none, as when an
 * area outside the workspace was opened directly. */
export function lastWorkspacePage(trail: Trail): { href: string; delta: number } | null {
  for (let i = trail.index - 1; i >= 0; i--) {
    const entry = trail.entries[i];
    if (!underAreaOutsideWorkspace(entry.pathname)) return { href: entry.href, delta: i - trail.index };
  }
  return null;
}

/** Where "Back to workspace" leads: the page someone left the workspace from,
 * by stepping back through history, or null to fall back to the home page. */
export function useWayBackToWorkspace(): { href: string; delta: number } | null {
  const location = useLocation();
  const type = useNavigationType();
  const trail = useRef(EMPTY_TRAIL);
  trail.current = follow(trail.current, location, type);
  return lastWorkspacePage(trail.current);
}
