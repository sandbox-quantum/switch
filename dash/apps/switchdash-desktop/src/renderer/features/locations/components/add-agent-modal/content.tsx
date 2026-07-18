import { useId } from 'react';
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { LocalDirectorySelector } from './local-directory-selector';
import { type PickModeState } from './modes';

// switchdash adds agents from existing local directories only. The SSH / create-new /
// clone panels from switchdash are out of scope for v0 and have been removed.
export function PickExistingPanel({
  state,
  showName = true,
}: {
  state: PickModeState;
  /** Hide the local display-name field — used when onboarding a brand-new agent,
   * where the name is derived from the directory and the Switch agent name is
   * collected separately in the configure panel. */
  showName?: boolean;
}) {
  const nameId = useId();
  return (
    <FieldGroup>
      <Field>
        <FieldLabel>Directory</FieldLabel>
        <LocalDirectorySelector
          path={state.path}
          onPathChange={state.handlePathChange}
          title="Select a Switch agent directory"
          message="Select the agent's working directory"
        />
      </Field>
      {showName && (
        <Field>
          <FieldLabel htmlFor={nameId}>Name</FieldLabel>
          <Input
            id={nameId}
            placeholder="Enter an agent name"
            value={state.name}
            onChange={(e) => state.handleNameChange(e.target.value)}
          />
        </Field>
      )}
    </FieldGroup>
  );
}
