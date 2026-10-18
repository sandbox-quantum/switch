/** A Slack app of your own: Slack's create-app page, filled in for this server. */
export type SlackOwnAppSetup = { createUrl: string };

/** Both tokens of a Slack app work, and the workspace they belong to. */
export type SlackTokensChecked = { workspaceId: string; workspaceName: string; botName: string };
