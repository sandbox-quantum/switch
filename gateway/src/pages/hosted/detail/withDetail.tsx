import type { ComponentType } from "react";
import { Route, Routes } from "react-router";

/**
 * A Hosted tab with a detail page under it: the tab's own page at
 * `/hosted/<tab>`, and `Detail` at `/hosted/<tab>/<id>`. The shell mounts each
 * tab at `<tab>/*`, so these routes are relative to it.
 */
export function withDetail(List: ComponentType, Detail: ComponentType, param: string): ComponentType {
  function TabWithDetail() {
    return (
      <Routes>
        <Route index element={<List />} />
        <Route path={`:${param}`} element={<Detail />} />
      </Routes>
    );
  }
  TabWithDetail.displayName = `WithDetail(${List.displayName ?? List.name})`;
  return TabWithDetail;
}
