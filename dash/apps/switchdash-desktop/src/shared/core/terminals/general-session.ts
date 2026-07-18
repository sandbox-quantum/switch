export interface GeneralSession {
  type: 'general';
  config: GeneralSessionConfig;
}

export interface GeneralSessionConfig {
  sessionId?: string;
  cwd: string;
  locationPath?: string;
  shellSetup?: string;
  tmuxSessionName?: string;
  command?: string;
  args?: string[];
}
