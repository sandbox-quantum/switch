import type { ComponentType } from "react";
import AlertsTab from "./alerts/AlertsTab";
import AuditTab from "./audit/AuditTab";
import BoxesTab from "./boxes/BoxesTab";
import IsolationTab from "./isolation/IsolationTab";
import MachinesTab from "./machines/MachinesTab";
import OperatorsTab from "./operators/OperatorsTab";
import OverviewTab from "./overview/OverviewTab";

/** One tab of Switch web's Hosted page.
 *
 *  `key` is the tab's URL segment (`/hosted/<key>`); anything after it
 *  (`/hosted/<key>/...`) belongs to the tab, which can route it with its own
 *  descendant `<Routes>`. The component takes no props: it reads `useHosted()`
 *  for the operator and `refresh()`, fetches its own data through Core's
 *  operator routes, and renders `<HostedRefusal />` when one of them answers
 *  403. */
export interface HostedTab {
  key: HostedTabKey;
  label: string;
  component: ComponentType;
}

/** p10's tab bar, in its order. The shell shows the tabs in this order
 *  whatever order `HOSTED_TABS` lists them in, so each owner adds one line
 *  below without touching anyone else's. A key with no entry isn't shown. */
export const TAB_ORDER = [
  "overview",
  "boxes",
  "machines",
  "isolation",
  "alerts",
  "audit",
  "operators",
] as const;

export type HostedTabKey = (typeof TAB_ORDER)[number];

/** Add a tab with one line here, importing its component from its own folder
 *  (`./<folder>/...`). This is the only file the tab owners share. */
export const HOSTED_TABS: HostedTab[] = [
  { key: "overview", label: "Overview", component: OverviewTab },
  { key: "boxes", label: "Boxes", component: BoxesTab },
  { key: "machines", label: "Machines", component: MachinesTab },
  { key: "isolation", label: "Isolation", component: IsolationTab },
  { key: "alerts", label: "Alerts", component: AlertsTab },
  { key: "audit", label: "Audit log", component: AuditTab },
  { key: "operators", label: "Operators", component: OperatorsTab },
];

/** The tabs to show, in p10's order, one per key. */
export function orderedTabs(tabs: readonly HostedTab[]): HostedTab[] {
  return TAB_ORDER.flatMap((key) => {
    const tab = tabs.find((t) => t.key === key);
    return tab ? [tab] : [];
  });
}
