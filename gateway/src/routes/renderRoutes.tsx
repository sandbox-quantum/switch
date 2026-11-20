import type { ReactNode } from "react";
import { Route } from "react-router";
import type { SettingsArea } from "../data/settingsLanding";
import { Guarded, RedirectTo } from "./Guarded";
import { type AppRoute, ROUTES } from "./routeTable";
import { SettingsIndex, SettingsLayout } from "./SettingsLayout";

function routePath(path: string): { index: true } | { path: string } {
  return path === "/" ? { index: true } : { path: path.slice(1) };
}

function routeElement(route: AppRoute): ReactNode {
  const key = `${route.kind}:${route.path}`;
  switch (route.kind) {
    case "page":
      return (
        <Route
          key={key}
          {...routePath(route.path)}
          element={<Guarded access={route.access}>{route.element}</Guarded>}
        />
      );
    case "area":
      return (
        <Route
          key={key}
          {...routePath(route.path)}
          element={<SettingsIndex area={route.area} />}
        />
      );
    case "redirect":
      return <Route key={key} {...routePath(route.path)} element={<RedirectTo to={route.to} />} />;
  }
}

/** The signed-in dashboard's routes, from the route table. A settings area's
 * pages share its layout route, which draws the area's menu. */
export function renderRoutes(): ReactNode[] {
  const top: ReactNode[] = [];
  const byArea = new Map<SettingsArea, ReactNode[]>();
  for (const route of ROUTES) {
    if (route.kind === "page" && route.area !== undefined) {
      const pages = byArea.get(route.area) ?? [];
      pages.push(routeElement(route));
      byArea.set(route.area, pages);
    } else {
      top.push(routeElement(route));
    }
  }
  for (const [area, pages] of byArea) {
    top.push(
      <Route key={`area-layout:${area}`} element={<SettingsLayout area={area} />}>
        {pages}
      </Route>,
    );
  }
  return top;
}
