import { Box, CircularProgress } from "@mui/material";
import { type ComponentType, Suspense } from "react";
import { Route, Routes } from "react-router";

/**
 * A Hosted tab with a detail page under it: the tab's own page at
 * `/hosted/<tab>`, and `Detail` at `/hosted/<tab>/<id>`. The shell mounts each
 * tab at `<tab>/*`, so these routes are relative to it. `Detail` may be a
 * `React.lazy` page: it loads (with its charts) only when one is opened.
 */
export function withDetail(List: ComponentType, Detail: ComponentType, param: string): ComponentType {
  function TabWithDetail() {
    return (
      <Routes>
        <Route index element={<List />} />
        <Route
          path={`:${param}`}
          element={
            <Suspense
              fallback={
                <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
                  <CircularProgress size={28} aria-label="Loading" />
                </Box>
              }
            >
              <Detail />
            </Suspense>
          }
        />
      </Routes>
    );
  }
  TabWithDetail.displayName = `WithDetail(${List.displayName ?? List.name})`;
  return TabWithDetail;
}
