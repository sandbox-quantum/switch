import { render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentProfileActions } from './agent-profile-actions';

describe('AgentProfileActions', () => {
  it('renders without crashing when agent is stopped', () => {
    const { container } = render(
      <AgentProfileActions
        desiredState="stopped"
        busy={false}
        onToggleState={vi.fn()}
        onMove={vi.fn()}
      />
    );
    const turnOnButton = within(container).getByRole('button', { name: /turn on agent/i });
    expect(turnOnButton).not.toBeDisabled();
    const moveButton = within(container).getByRole('button', { name: /move to another device/i });
    expect(moveButton).not.toBeDisabled();
  });

  it('renders without crashing when agent is running', () => {
    const { container } = render(
      <AgentProfileActions
        desiredState="running"
        busy={false}
        onToggleState={vi.fn()}
        onMove={vi.fn()}
      />
    );
    const turnOffButton = within(container).getByRole('button', { name: /turn off agent/i });
    expect(turnOffButton).not.toBeDisabled();
    const moveButton = within(container).getByRole('button', { name: /move to another device/i });
    expect(moveButton).not.toBeDisabled();
  });

  it('renders without crashing when busy', () => {
    const { container } = render(
      <AgentProfileActions
        desiredState="running"
        busy={true}
        onToggleState={vi.fn()}
        onMove={vi.fn()}
      />
    );
    const turnOffButton = within(container).getByRole('button', { name: /turn off agent/i });
    expect(turnOffButton).toBeDisabled();
    const moveButton = within(container).getByRole('button', { name: /move to another device/i });
    expect(moveButton).toBeDisabled();
  });
});
