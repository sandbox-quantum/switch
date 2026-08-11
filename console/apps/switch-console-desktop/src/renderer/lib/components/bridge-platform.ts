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

/** Where the setup guides live. */
const DOCS_BASE = 'https://github.com/sandbox-quantum/switch/blob/main/docs/bridges';

/**
 * Per-platform setup guide, for the "how do I get these credentials" link on
 * the attach form.
 *
 * These point at the repository's own markdown on `main`, which is a stopgap:
 * they are expected to move to published documentation, so they are collected
 * here rather than spread through the JSX — changing them later is one edit.
 */
const PLATFORM_DOCS: Record<string, string> = {
  slack: `${DOCS_BASE}/SLACK_SETUP.md`,
  mattermost: `${DOCS_BASE}/MATTERMOST_SETUP.md`,
  discord: `${DOCS_BASE}/DISCORD_SETUP.md`,
  teams: `${DOCS_BASE}/TEAMS_SETUP.md`,
  telegram: `${DOCS_BASE}/TELEGRAM_SETUP.md`,
};

/**
 * The setup guide for a platform, or the index covering all of them when this
 * build knows no specific page — so a bridge type added server-side still gets
 * a link that lands somewhere useful instead of a 404.
 */
export function bridgeSetupDocsUrl(bridgeType: string): string {
  return PLATFORM_DOCS[bridgeType] ?? `${DOCS_BASE}/README.md`;
}
