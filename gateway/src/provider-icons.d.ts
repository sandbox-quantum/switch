/* The one type the AI providers' icons (`@switch-console/provider-icons/*`)
 * import from Console's plugin core, which the dashboard does not compile. */
declare module "@switch-console/core/agents/plugins" {
  export type AgentIconAsset = {
    kind: "svg" | "image";
    alt?: string;
    invertInDark?: boolean;
    variants: { minSize: number; light: string; dark?: string }[];
  };
}
