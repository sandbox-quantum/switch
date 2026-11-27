import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Dialog, DialogContent } from '../primitives/dialog';
import { MoveAgentModal, type MoveAgentMachine } from './move-agent-modal';

const mockMachines: MoveAgentMachine[] = [
  {
    id: 'machine-1',
    name: 'Desktop Machine',
    kind: 'console',
    state: 'online',
    thisComputer: false,
    selectable: true,
    selectabilityTone: 'ok',
    selectabilityLine: 'Ready: claude signed in',
    namesake: null,
  },
  {
    id: 'machine-2',
    name: 'Offline Machine',
    kind: 'console',
    state: 'offline',
    thisComputer: false,
    selectable: false,
    selectabilityTone: 'idle',
    selectabilityLine: 'Offline. Bring it online to move agents here.',
    namesake: null,
  },
];

function renderModal(props: Partial<React.ComponentProps<typeof MoveAgentModal>> = {}) {
  return render(
    <Dialog open={true} onOpenChange={vi.fn()}>
      <DialogContent>
        <MoveAgentModal
          agentName="Test Agent"
          currentMachineName="Current Machine"
          workingDirectory="/home/user"
          machines={mockMachines}
          machinesError={null}
          moving={false}
          moveError={null}
          onMove={vi.fn()}
          onClose={vi.fn()}
          {...props}
        />
      </DialogContent>
    </Dialog>
  );
}

describe('MoveAgentModal', () => {
  it('renders agent name in title', () => {
    renderModal();
    expect(screen.getByText(/Move Test Agent to another device/i)).toBeInTheDocument();
  });

  it('renders machine options', () => {
    renderModal();
    const radioGroup = screen.getByRole('radiogroup');
    expect(within(radioGroup).getByText(/Desktop Machine/)).toBeInTheDocument();
    expect(within(radioGroup).getByText(/Offline Machine/)).toBeInTheDocument();
  });

  it('disables Move button when no machine selected', () => {
    renderModal();
    expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled();
  });

  it('enables Move button when selectable machine is picked', async () => {
    const user = userEvent.setup();
    renderModal();
    const radioGroup = screen.getByRole('radiogroup');
    await user.click(within(radioGroup).getByText('Desktop Machine'));
    expect(screen.getByRole('button', { name: 'Move' })).not.toBeDisabled();
  });

  it('calls onMove with machine id when Move clicked', async () => {
    const user = userEvent.setup();
    const onMove = vi.fn().mockResolvedValue(undefined);
    renderModal({ onMove });
    const radioGroup = screen.getByRole('radiogroup');
    await user.click(within(radioGroup).getByText('Desktop Machine'));
    await user.click(screen.getByRole('button', { name: 'Move' }));
    expect(onMove).toHaveBeenCalledWith('machine-1');
  });

  it('shows error message when machinesError provided', () => {
    renderModal({ machines: null, machinesError: 'Failed to load machines' });
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load machines');
  });

  it('shows move error when provided', () => {
    renderModal({ moveError: 'Failed to move agent' });
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to move agent');
  });

  it('shows Moving… when moving', () => {
    renderModal({ moving: true });
    expect(screen.getByRole('button', { name: 'Moving…' })).toBeInTheDocument();
  });

  it('handles rejected move without unhandled promise rejection', async () => {
    const user = userEvent.setup();
    const onMove = vi.fn().mockRejectedValue(new Error('Move failed'));
    const { rerender } = renderModal({ onMove });

    const radioGroup = screen.getByRole('radiogroup');
    await user.click(within(radioGroup).getByText('Desktop Machine'));
    await user.click(screen.getByRole('button', { name: 'Move' }));

    expect(onMove).toHaveBeenCalledWith('machine-1');

    rerender(
      <Dialog open={true} onOpenChange={vi.fn()}>
        <DialogContent>
          <MoveAgentModal
            agentName="Test Agent"
            currentMachineName="Current Machine"
            workingDirectory="/home/user"
            machines={mockMachines}
            machinesError={null}
            moving={false}
            moveError="Move failed"
            onMove={onMove}
            onClose={vi.fn()}
          />
        </DialogContent>
      </Dialog>
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Move failed');
  });
});
