import { observable, runInAction } from 'mobx';
import type { RemoteBridgeType } from '@shared/core/switch-servers/switch-servers';
import { SWITCH_DOCS_MESSAGING_APPS_URL } from '@shared/urls';

/**
 * Display names, setup guides and logos for collaboration bridge platforms,
 * keyed by the gateway's `bridge_type`.
 *
 * The server is the source: each platform's adapter declares its own name, docs
 * page and icon, and switch-core lists them with its bridge types. They are
 * learned here as those lists arrive ({@link learnBridgePlatforms}), so a
 * platform added server-side is named and drawn without an app release.
 *
 * The raw key is a lowercase slug (`teams`, `mattermost`), which reads badly in
 * user-facing copy — "Open in teams" — so anything shown to a user goes through
 * {@link bridgePlatformLabel} rather than interpolating the key.
 */
type LearnedPlatform = {
  displayName: string | null;
  docsSlug: string | null;
  iconSvg: string | null;
};

const learned = observable.map<string, LearnedPlatform>();

/** Record what a server says about its platforms. */
export function learnBridgePlatforms(types: readonly RemoteBridgeType[]): void {
  runInAction(() => {
    for (const type of types) {
      // A server predating platform metadata sends none of it; keep whatever a
      // newer server already taught us rather than forgetting it.
      if (type.displayName === null && type.docsSlug === null && type.iconSvg === null) continue;
      learned.set(type.key, {
        displayName: type.displayName,
        docsSlug: type.docsSlug,
        iconSvg: type.iconSvg,
      });
    }
  });
}

/**
 * What this build shipped knowing, for a server too old to describe its own
 * platforms. A new platform never needs an entry here: any server that has it
 * also describes it.
 */
const BUNDLED_LABELS: Record<string, string> = {
  slack: 'Slack',
  mattermost: 'Mattermost',
  discord: 'Discord',
  teams: 'Microsoft Teams',
  telegram: 'Telegram',
};

/** The docs site's slugs for the bundled platforms (`teams` is published as
 * `microsoft-teams`), for the same older servers. */
const BUNDLED_DOCS_SLUGS: Record<string, string> = {
  slack: 'slack',
  mattermost: 'mattermost',
  discord: 'discord',
  teams: 'microsoft-teams',
  telegram: 'telegram',
};

/**
 * How to name a bridge platform in the UI. Falls back to the raw key for a type
 * no server has described — wrong-looking, but still identifying, which beats
 * hiding it.
 */
export function bridgePlatformLabel(bridgeType: string | null | undefined): string {
  if (!bridgeType) return 'messaging app';
  return learned.get(bridgeType)?.displayName ?? BUNDLED_LABELS[bridgeType] ?? bridgeType;
}

/**
 * The setup guide for a platform, or the index covering all of them when no
 * specific page is known — so a bridge type without a page of its own still gets
 * a link that lands somewhere useful instead of a 404.
 */
export function bridgeSetupDocsUrl(bridgeType: string): string {
  const slug = learned.get(bridgeType)?.docsSlug ?? BUNDLED_DOCS_SLUGS[bridgeType];
  return slug ? `${SWITCH_DOCS_MESSAGING_APPS_URL}/${slug}` : SWITCH_DOCS_MESSAGING_APPS_URL;
}

/** The logo a server provided for a platform, as SVG markup, or null. */
export function learnedBridgeIconSvg(bridgeType: string): string | null {
  return learned.get(bridgeType)?.iconSvg ?? null;
}
