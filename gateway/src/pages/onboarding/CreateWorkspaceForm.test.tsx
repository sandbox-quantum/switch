import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import CreateWorkspaceForm from './CreateWorkspaceForm';
import * as api from '../../data/api';

vi.mock('../../data/api');

describe('CreateWorkspaceForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as { location?: unknown }).location;
    (window as { location: { assign: unknown } }).location = { assign: vi.fn() };
  });

  afterEach(() => cleanup());

  it('renders with organization name field', () => {
    render(<CreateWorkspaceForm />);
    expect(screen.getByLabelText(/organization name/i)).toBeTruthy();
    expect(screen.getByPlaceholderText(/your company or team/i)).toBeTruthy();
  });

  it('disables submit when name is empty', () => {
    render(<CreateWorkspaceForm />);
    const submit = screen.getByRole('button', { name: /create organization/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it('enables submit when name is provided', () => {
    render(<CreateWorkspaceForm />);
    const input = screen.getByLabelText(/organization name/i) as HTMLInputElement;
    const submit = screen.getByRole('button', { name: /create organization/i }) as HTMLButtonElement;

    fireEvent.change(input, { target: { value: 'Acme Corp' } });
    expect(submit.disabled).toBe(false);
  });

  it('creates tenant and redirects on submit', async () => {
    vi.mocked(api.createTenant).mockResolvedValue({ id: 'tenant-1', name: 'Acme Corp' } as never);

    render(<CreateWorkspaceForm landing="/get-started" />);
    const input = screen.getByLabelText(/organization name/i);
    fireEvent.change(input, { target: { value: 'Acme Corp' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(api.createTenant).toHaveBeenCalledWith('Acme Corp');
      expect(window.location.assign).toHaveBeenCalledWith('/get-started');
    });
  });

  it('shows error when creation fails', async () => {
    vi.mocked(api.createTenant).mockRejectedValue(new Error('Name already taken'));

    render(<CreateWorkspaceForm />);
    const input = screen.getByLabelText(/organization name/i);
    fireEvent.change(input, { target: { value: 'Acme Corp' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(screen.getByText('Name already taken')).toBeTruthy();
    });
  });

  it('shows cancel button when onCancel provided', () => {
    const onCancel = vi.fn();
    render(<CreateWorkspaceForm onCancel={onCancel} />);
    expect(screen.getByRole('button', { name: /cancel/i })).toBeTruthy();
  });

  it('calls onCancel when cancel clicked', () => {
    const onCancel = vi.fn();
    render(<CreateWorkspaceForm onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('trims whitespace from name', async () => {
    vi.mocked(api.createTenant).mockResolvedValue({} as never);

    render(<CreateWorkspaceForm />);
    const input = screen.getByLabelText(/organization name/i);
    fireEvent.change(input, { target: { value: '  Acme Corp  ' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(api.createTenant).toHaveBeenCalledWith('Acme Corp');
    });
  });
});
