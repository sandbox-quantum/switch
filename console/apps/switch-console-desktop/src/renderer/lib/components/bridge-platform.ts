import { SWITCH_DOCS_MESSAGING_APPS_URL } from '@shared/urls';

/**
 * Display names and setup guides for collaboration bridge platforms, keyed by
 * the gateway's `bridge_type`.
 *
 * The raw key is a lowercase slug (`teams`, `mattermost`), which reads badly in
 * user-facing copy — "Open in teams" — so anything shown to a user goes through
 * {@link bridgePlatformLabel} rather than interpolating the key.
 */
const PLATFORM_LABELS: Record<string, string> = {
  slack: 'Slack',
  mattermost: 'Mattermost',
  discord: 'Discord',
  teams: 'Microsoft Teams',
  telegram: 'Telegram',
};

/**
 * How to name a bridge platform in the UI. Falls back to the raw key for a type
 * a newer switch-core added but this build has no name for — wrong-looking, but
 * still identifying, which beats hiding it.
 */
export function bridgePlatformLabel(bridgeType: string | null | undefined): string {
  if (!bridgeType) return 'messaging app';
  return PLATFORM_LABELS[bridgeType] ?? bridgeType;
}

/**
 * Per-platform setup guide, for the "how do I get these credentials" link on
 * the attach form.
 *
 * The slugs are the documentation site's, not the bridge keys: `teams` is
 * published as `microsoft-teams`. Collected here rather than spread through the
 * JSX so the mapping is checkable in one place.
 */
const PLATFORM_DOCS: Record<string, string> = {
  slack: `${SWITCH_DOCS_MESSAGING_APPS_URL}/slack`,
  mattermost: `${SWITCH_DOCS_MESSAGING_APPS_URL}/mattermost`,
  discord: `${SWITCH_DOCS_MESSAGING_APPS_URL}/discord`,
  teams: `${SWITCH_DOCS_MESSAGING_APPS_URL}/microsoft-teams`,
  telegram: `${SWITCH_DOCS_MESSAGING_APPS_URL}/telegram`,
};

/**
 * The setup guide for a platform, or the index covering all of them when this
 * build knows no specific page — so a bridge type added server-side still gets
 * a link that lands somewhere useful instead of a 404.
 */
export function bridgeSetupDocsUrl(bridgeType: string): string {
  return PLATFORM_DOCS[bridgeType] ?? SWITCH_DOCS_MESSAGING_APPS_URL;
}
