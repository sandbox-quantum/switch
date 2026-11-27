import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentIdentityEditor } from './agent-identity-editor';

describe('AgentIdentityEditor', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders display name and description', () => {
    const onDisplayNameChange = vi.fn();
    const onDescriptionChange = vi.fn();

    render(
      <AgentIdentityEditor
        displayName="Test Agent"
        placeholder="agent-id"
        description="A test description"
        onDisplayNameChange={onDisplayNameChange}
        onDescriptionChange={onDescriptionChange}
        iconPicker={<div data-testid="icon-picker">Icon</div>}
      />
    );

    expect(screen.getByText('Test Agent')).toBeInTheDocument();
    expect(screen.getByText('A test description')).toBeInTheDocument();
    expect(screen.getByTestId('icon-picker')).toBeInTheDocument();
  });

  it('allows editing display name', async () => {
    const user = userEvent.setup();
    const onDisplayNameChange = vi.fn();
    const onDescriptionChange = vi.fn();

    render(
      <AgentIdentityEditor
        displayName="Test Agent"
        placeholder="agent-id"
        description="A test description"
        onDisplayNameChange={onDisplayNameChange}
        onDescriptionChange={onDescriptionChange}
        iconPicker={<div>Icon</div>}
      />
    );

    const nameButton = screen.getByText('Test Agent');
    await user.click(nameButton);

    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('allows editing description', async () => {
    const user = userEvent.setup();
    const onDisplayNameChange = vi.fn();
    const onDescriptionChange = vi.fn();

    render(
      <AgentIdentityEditor
        displayName="Test Agent"
        placeholder="agent-id"
        description="A test description"
        onDisplayNameChange={onDisplayNameChange}
        onDescriptionChange={onDescriptionChange}
        iconPicker={<div>Icon</div>}
      />
    );

    const descButton = screen.getByText('A test description');
    await user.click(descButton);

    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });
});
