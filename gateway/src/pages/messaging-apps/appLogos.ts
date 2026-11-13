import { useMemo } from "react";
import { useBridgeTypes } from "../../data/hooks";

/** Each messaging platform's logo, as Switch serves it, ready for an `<img>`:
 * a data: URL, since the markup is the server's and is never inlined into the
 * page. A platform Switch ships no logo for is left out, and its tile shows
 * initials. */
export function useAppLogos(): ReadonlyMap<string, string> {
  const { data: types } = useBridgeTypes();
  return useMemo(
    () =>
      new Map(
        (types ?? []).flatMap((type) =>
          type.icon_svg
            ? [[type.key, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(type.icon_svg)}`] as const]
            : [],
        ),
      ),
    [types],
  );
}
