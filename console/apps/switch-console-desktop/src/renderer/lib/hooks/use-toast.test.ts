import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Identical toasts must take one slot, not one per firing (CHOO-2344).
 *
 * Anything toasting from a repeating trigger — a refresh, a poll, a retry —
 * otherwise stacks copies of a single problem faster than they can be
 * dismissed. Sonner replaces a toast whose id it already holds, so a stable id
 * derived from the text is what collapses them.
 */

const sonnerToast = Object.assign(vi.fn(), { error: vi.fn() });

vi.mock('sonner', () => ({ toast: sonnerToast }));

const { toast } = await import('./use-toast');

describe('toast identity', () => {
  beforeEach(() => {
    sonnerToast.mockClear();
    sonnerToast.error.mockClear();
  });

  it('gives the same text and severity the same id', () => {
    toast({ title: 'Nope', description: 'it broke', variant: 'destructive' });
    toast({ title: 'Nope', description: 'it broke', variant: 'destructive' });

    const [first, second] = sonnerToast.error.mock.calls.map((call) => call[1].id);
    expect(first).toBe(second);
  });

  it('separates toasts that differ in text', () => {
    toast({ title: 'Nope', description: 'it broke', variant: 'destructive' });
    toast({ title: 'Nope', description: 'it broke differently', variant: 'destructive' });

    const [first, second] = sonnerToast.error.mock.calls.map((call) => call[1].id);
    expect(first).not.toBe(second);
  });

  it('separates the same text at different severities', () => {
    toast({ title: 'Saved', variant: 'destructive' });
    toast({ title: 'Saved' });

    const errorId = sonnerToast.error.mock.calls[0][1].id;
    const plainId = sonnerToast.mock.calls[0][1].id;
    expect(errorId).not.toBe(plainId);
  });

  it('lets a caller override the identity', () => {
    toast({ title: 'Same words', id: 'left' });
    toast({ title: 'Same words', id: 'right' });

    const [first, second] = sonnerToast.mock.calls.map((call) => call[1].id);
    expect(first).toBe('left');
    expect(second).toBe('right');
  });

  it('still passes the action through', () => {
    const onClick = vi.fn();
    toast({ title: 'Retry?', action: { label: 'Retry', onClick } });

    expect(sonnerToast.mock.calls[0][1].action).toEqual({ label: 'Retry', onClick });
  });
});
