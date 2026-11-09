import { lazy, Suspense, type ComponentProps } from "react";

// The agent page's cloud controls (hosted agents v2), loaded on first use in a
// chunk of their own, so a v1 visitor downloads none of them. Each renders
// nothing while its chunk loads.

const controls = () => import("./CloudAgentControls");
const Section = lazy(() => controls().then((module) => ({ default: module.CloudAgentSection })));
const Rename = lazy(() => controls().then((module) => ({ default: module.CloudRenameDialog })));

type SectionProps = ComponentProps<typeof import("./CloudAgentControls").CloudAgentSection>;
type RenameProps = ComponentProps<typeof import("./CloudAgentControls").CloudRenameDialog>;

export function CloudAgentSection(props: SectionProps) {
  return (
    <Suspense fallback={null}>
      <Section {...props} />
    </Suspense>
  );
}

export function CloudRenameDialog(props: RenameProps) {
  return (
    <Suspense fallback={null}>
      <Rename {...props} />
    </Suspense>
  );
}
