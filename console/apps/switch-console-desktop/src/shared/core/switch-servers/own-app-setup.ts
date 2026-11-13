/** A Slack app of your own: Slack's create-app page, filled in for this server. */
export type SlackOwnAppSetup = {
  createUrl: string;
  /** The app's manifest as JSON, for pasting into Slack's "Paste a manifest"
   * when its create page does not take the one in `createUrl`. Null from a
   * server that does not send it. */
  manifestJson: string | null;
};

/** Both tokens of a Slack app work, and the workspace they belong to. */
export type SlackTokensChecked = { workspaceId: string; workspaceName: string; botName: string };
