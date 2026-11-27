import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentMachineRows } from './agent-machine-rows';

describe('AgentMachineRows', () => {
  it('renders without crashing with machine name', () => {
    const { container } = render(
      <AgentMachineRows
        machineName="My Machine"
        thisComputer={false}
        directory="/home/user/projects"
        isolation="shared"
        cloud={false}
        machineWord="machine"
      />
    );
    expect(container).toBeTruthy();
  });

  it('renders without crashing for this computer', () => {
    const { container } = render(
      <AgentMachineRows
        machineName={null}
        thisComputer={true}
        directory="/home/user/projects"
        isolation="shared"
        cloud={false}
        machineWord="machine"
      />
    );
    expect(container).toBeTruthy();
  });

  it('renders without crashing for cloud machine', () => {
    const { container } = render(
      <AgentMachineRows
        machineName="Cloud Machine"
        thisComputer={false}
        directory="/home/user/projects"
        isolation="isolated"
        cloud={true}
        machineWord="machine"
      />
    );
    expect(container).toBeTruthy();
  });

  it('directory input has accessible name', () => {
    const onDirectoryChange = vi.fn();
    render(
      <AgentMachineRows
        machineName="Test Machine"
        thisComputer={false}
        directory="/home/user/projects"
        isolation="shared"
        cloud={false}
        onDirectoryChange={onDirectoryChange}
        machineWord="machine"
      />
    );
    expect(screen.getByRole('textbox', { name: 'Directory' })).toBeInTheDocument();
  });
});
