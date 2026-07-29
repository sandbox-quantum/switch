/** Configuration the Gateway reads at RUNTIME rather than build time.
 *
 * The gateway ships as a prebuilt image: the Helm chart and the compose file
 * pull it, they do not build it. Anything baked into the bundle at build time
 * is therefore fixed for everyone who deploys that image, which is wrong for
 * per-deployment values. `config.js` is written by the container entrypoint
 * from the environment and loaded before the app, so operators configure their
 * own deployment without rebuilding. */
export interface GatewayRuntimeConfig {
  /** MUI X Pro licence key. Each organisation supplies its own — a licence
   *  cannot be redistributed, so the published image never carries one. */
  muiXLicenseKey?: string;
}

declare global {
  interface Window {
    __SWITCH_GATEWAY_CONFIG__?: GatewayRuntimeConfig;
  }
}

export function runtimeConfig(): GatewayRuntimeConfig {
  return window.__SWITCH_GATEWAY_CONFIG__ ?? {};
}
