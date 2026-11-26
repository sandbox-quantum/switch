import { type ReactNode, type Ref, useState } from 'react';
import { Button } from '../primitives/button';
import { Switch } from '../primitives/switch';
import { AgentInstructionsField } from './agent-instructions-field';
import { AgentMachineRows, type AgentMachineRowsProps } from './agent-machine-rows';
import { SectionLabel } from './agent-page-section';
import { AutoApproveRow, AutoModeRow, PERMISSION_COPY } from './agent-permissions';
import { InlineEditableText } from './inline-editable-text';
import { SettingRow } from './setting-row';

/** Who the agent is, as its page's header shows it and lets it be changed. */
export type AgentSettingsIdentity = {
  avatar: ReactNode;
  /** The agent's own name, shown under a display name that differs from it. */
  name: string;
  displayName: string;
  description: string;
  /** Null when the person cannot change them. */
  onDisplayNameChange: ((value: string) => void) | null;
  onDescriptionChange: ((value: string) => void) | null;
  badges: ReactNode;
  /** Small controls on the right of the title's line (Rename, Delete); null for none. */
  titleActions: ReactNode;
  actions: ReactNode;
};

/** How the agent works, from the definition its machine runs it with. */
export type AgentSettingsDefinition = {
  instructions: string;
  onInstructionsChange: (value: string) => void;
  /** Null where its provider has no automatic review of its own. */
  autoMode: boolean | null;
  /** Its provider's name where nothing reviews an action in auto mode (OpenCode), else null. */
  unreviewedAutoMode: string | null;
  onAutoModeChange: (checked: boolean) => void;
  autoApprove: boolean;
  onAutoApproveChange: (checked: boolean) => void;
};

/**
 * An agent's settings page, as Switch Console draws it: who it is, its
 * instructions, its General settings (permissions, the rows the server holds,
 * where it runs), its advanced configuration and its danger zone. The values
 * and what saving them means are the app's: every edit here is reported, and
 * the app's save bar saves them together.
 */
export function AgentSettingsPage({
  saveBar,
  error,
  identity,
  definition,
  serverRows,
  machine,
  advanced,
  onDelete,
  deleting,
  machineWord,
}: {
  /** The bar for unsaved changes, above the scrolling page. */
  saveBar: ReactNode;
  error: string | null;
  identity: AgentSettingsIdentity;
  /** Null for an agent whose definition is not shown here. */
  definition: AgentSettingsDefinition | null;
  /** General's rows the server holds and saves as they change. */
  serverRows: ReactNode;
  /** Where it runs; null for an agent that runs elsewhere. */
  machine: AgentMachineRowsProps | null;
  /** The advanced configuration and what is said under it; null for none. */
  advanced: ReactNode;
  /** Null where the agent cannot be deleted from here. */
  onDelete: (() => void) | null;
  deleting: boolean;
  /** What the app calls a computer that runs agents. */
  machineWord: 'machine' | 'device';
}) {
  const [instructionsExpanded, setInstructionsExpanded] = useState(false);
  const title = identity.displayName.trim() || identity.name;
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      {saveBar}
      {error && (
        <p
          role="alert"
          className="shrink-0 border-b border-border px-8 py-3 text-sm text-foreground-destructive"
        >
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[900px] flex-col gap-10 px-8 pb-20">
          <header className="flex shrink-0 items-start gap-5 pt-10">
            <span className="flex size-[88px] shrink-0 items-center justify-center">
              {identity.avatar}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex min-w-0 items-start gap-3">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1.5">
                  <h1 className="max-w-full shrink-0 text-3xl font-semibold tracking-tight [overflow-wrap:anywhere] text-foreground">
                    {identity.onDisplayNameChange ? (
                      <InlineEditableText
                        value={identity.displayName}
                        placeholder={identity.name}
                        mutedPlaceholder={false}
                        label="Display name"
                        className="text-3xl font-semibold tracking-tight"
                        onChange={identity.onDisplayNameChange}
                      />
                    ) : (
                      title
                    )}
                  </h1>
                  {identity.badges}
                </div>
                {identity.titleActions}
              </div>
              {title !== identity.name && (
                <p className="text-sm text-foreground-muted">
                  {machineWord === 'machine' ? 'Machine name' : 'Name'}: <span className="font-mono">{identity.name}</span>
                </p>
              )}
              {(identity.onDescriptionChange || identity.description) && (
                <p className="text-sm text-foreground-muted">
                  {identity.onDescriptionChange ? (
                    <InlineEditableText
                      value={identity.description}
                      placeholder="Add a description"
                      mutedPlaceholder
                      label="Description"
                      className="text-sm"
                      onChange={identity.onDescriptionChange}
                    />
                  ) : (
                    identity.description
                  )}
                </p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">{identity.actions}</div>
            </div>
          </header>

          <div className="flex flex-col gap-10">
            {definition && (
              <AgentInstructionsField
                value={definition.instructions}
                onChange={definition.onInstructionsChange}
                expanded={instructionsExpanded}
                onExpandedChange={setInstructionsExpanded}
                actions={null}
              />
            )}
            <section className="flex flex-col gap-6">
              <SectionLabel>General</SectionLabel>
              {definition && definition.autoMode !== null && (
                <AutoModeRow
                  unreviewed={definition.unreviewedAutoMode ? [definition.unreviewedAutoMode] : []}
                  overridden={definition.autoApprove}
                  control={
                    <Switch
                      aria-label={PERMISSION_COPY.autoMode.title}
                      checked={definition.autoMode}
                      onCheckedChange={definition.onAutoModeChange}
                    />
                  }
                />
              )}
              {definition && (
                <AutoApproveRow
                  control={
                    <Switch
                      aria-label={PERMISSION_COPY.autoApprove.title}
                      checked={definition.autoApprove}
                      onCheckedChange={definition.onAutoApproveChange}
                    />
                  }
                />
              )}
              {serverRows}
              {machine && <AgentMachineRows {...machine} machineWord={machineWord} />}
            </section>
            {advanced && <div className="flex flex-col gap-2">{advanced}</div>}
          </div>

          {onDelete && (
            <section className="flex flex-col gap-6">
              <SectionLabel>Danger zone</SectionLabel>
              <SettingRow
                title="Delete agent"
                info={null}
                description={`Its ${machineWord} stops it and it is deleted from Switch, for every room it is in.`}
                control={
                  <Button variant="destructive" disabled={deleting} onClick={onDelete}>
                    Delete agent…
                  </Button>
                }
              />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The page's pending changes, and what to do about them. Shown only while
 * something is unsaved; it sits above the scrolling content, so it stays in
 * view wherever on the page the edit was made.
 */
export function UnsavedChangesBar({
  saving,
  onDiscard,
  onSave,
  saveRef,
  shortcut,
}: {
  saving: boolean;
  onDiscard: () => void;
  onSave: () => void;
  saveRef: Ref<HTMLButtonElement> | undefined;
  /** The keys that save, beside Save; null for none. */
  shortcut: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border-warning bg-background-warning px-8 py-2">
      <span className="text-sm font-medium text-foreground-warning">Unsaved changes</span>
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={saving} onClick={onDiscard}>
          Discard
        </Button>
        <Button ref={saveRef} type="button" size="sm" disabled={saving} onClick={onSave}>
          <span className="flex items-center gap-2">
            {saving ? 'Saving…' : 'Save'}
            {shortcut}
          </span>
        </Button>
      </div>
    </div>
  );
}
