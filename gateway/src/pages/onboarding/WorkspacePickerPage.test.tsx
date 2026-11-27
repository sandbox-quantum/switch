import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import WorkspacePickerPage from './WorkspacePickerPage';
import { useAuth } from '../../data/AuthContext';

vi.mock('../../data/AuthContext');

/** Answers the invitations and domain-open workspaces the page asks for, and
 * a join, recording what was asked. */
function stubOffers(invitations: unknown[], joinable: unknown[]): string[] {
  const asked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input).replace(/^\/gateway/, '')}`;
      asked.push(key);
      const body =
        key === 'GET /invitations/mine' ? invitations : key === 'GET /joinable-tenants' ? joinable : { id: 'joined' };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return asked;
}

describe('WorkspacePickerPage', () => {
  const mockSwitchTo = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    stubOffers([], []);
    vi.mocked(useAuth).mockReturnValue({
      session: {
        user: { id: 'user-1', email: 'test@example.com' },
        tenants: [
          { id: 'tenant-1', name: 'Workspace A', role: 'admin' },
          { id: 'tenant-2', name: 'Workspace B', role: 'member' },
        ],
      },
      switchTo: mockSwitchTo,
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders title and subtitle', async () => {
    render(<WorkspacePickerPage />);
    expect(screen.getByText('Choose a workspace')).toBeTruthy();
    expect(await screen.findByText('You’re a member of these.')).toBeTruthy();
  });

  it('offers a workspace open to their email domain beside their own, and joins it', async () => {
    const asked = stubOffers([], [{ tenant_id: 't3', tenant_slug: 'c', tenant_name: 'Workspace C', domain: 'example.com' }]);
    delete (window as { location?: unknown }).location;
    (window as { location: { assign: unknown } }).location = { assign: vi.fn() };

    render(<WorkspacePickerPage />);
    expect(await screen.findByText('You’re a member of these, or can join them.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Workspace C.*Join/ }));

    await waitFor(() => expect(window.location.assign).toHaveBeenCalledWith('/'));
    expect(asked).toContain('POST /joinable-tenants/t3/join');
    expect(mockSwitchTo).not.toHaveBeenCalled();
  });

  it('lists all workspaces from session', () => {
    render(<WorkspacePickerPage />);
    expect(screen.getByText('Workspace A')).toBeTruthy();
    expect(screen.getByText('Workspace B')).toBeTruthy();
    expect(screen.getByText('admin')).toBeTruthy();
    expect(screen.getByText('member')).toBeTruthy();
  });

  it('switches to workspace on click', async () => {
    mockSwitchTo.mockResolvedValue(undefined);

    render(<WorkspacePickerPage />);
    fireEvent.click(screen.getByText('Workspace A'));

    await waitFor(() => {
      expect(mockSwitchTo).toHaveBeenCalledWith('tenant-1');
    });
  });

  it('shows error when switch fails', async () => {
    mockSwitchTo.mockRejectedValue(new Error('Workspace not found'));

    render(<WorkspacePickerPage />);
    fireEvent.click(screen.getByText('Workspace A'));

    await waitFor(() => {
      expect(screen.getByText('Workspace not found')).toBeTruthy();
    });
  });

  it('disables buttons while switching', async () => {
    mockSwitchTo.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));

    render(<WorkspacePickerPage />);
    const button = screen.getByText('Workspace A').closest('button') as HTMLButtonElement | null;
    fireEvent.click(button!);

    expect(button!.disabled).toBe(true);
  });

  it('handles empty workspace list', () => {
    vi.mocked(useAuth).mockReturnValue({
      session: { user: { id: 'user-1', email: 'test@example.com' }, tenants: [] },
      switchTo: mockSwitchTo,
    } as never);

    render(<WorkspacePickerPage />);
    expect(screen.queryByText('Workspace A')).toBeNull();
    expect(screen.queryByText('Workspace B')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });
});
