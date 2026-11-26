import { type ReactNode } from 'react';
import { InlineEditableText } from './inline-editable-text';

export type AgentIdentityEditorProps = {
  displayName: string;
  placeholder: string;
  description: string;
  onDisplayNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onDisplayNameCommit?: (value: string) => void;
  onDescriptionCommit?: (value: string) => void;
  /** Slot for the icon picker, which is app-specific */
  iconPicker: ReactNode;
};

/**
 * Agent identity editor: inline-editable name and description, plus a slot for
 * the icon picker. Used in both Console's managed agent page and the gateway's
 * agent settings.
 */
export function AgentIdentityEditor({
  displayName,
  placeholder,
  description,
  onDisplayNameChange,
  onDescriptionChange,
  onDisplayNameCommit,
  onDescriptionCommit,
  iconPicker,
}: AgentIdentityEditorProps) {
  return (
    <div className="flex items-start gap-6">
      {iconPicker}
      <div className="flex flex-1 flex-col gap-3">
        <InlineEditableText
          value={displayName}
          placeholder={placeholder}
          mutedPlaceholder={false}
          label="Display name"
          className="text-3xl font-semibold tracking-tight"
          onChange={onDisplayNameChange}
          onCommit={onDisplayNameCommit}
        />
        <InlineEditableText
          value={description}
          placeholder="Add a description"
          mutedPlaceholder
          label="Description"
          className="text-sm"
          onChange={onDescriptionChange}
          onCommit={onDescriptionCommit}
        />
      </div>
    </div>
  );
}
