import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  ManagedServerUpgrade,
  SwitchVersionDrift,
} from '@shared/core/managed-switch-server/managed-switch-server';
import { VersionDriftNotice } from './VersionDriftNotice';

const behind: SwitchVersionDrift = { deployed: '0.10.0', expected: '0.11.0', direction: 'upgrade' };

function render(props: {
  drift: SwitchVersionDrift | null;
  upgrade: ManagedServerUpgrade | null;
  progress?: string | null;
  disabled?: boolean;
}): string {
  return renderToStaticMarkup(
    createElement(VersionDriftNotice, {
      progress: null,
      disabled: false,
      onRestart: vi.fn(),
      ...props,
    })
  );
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

describe('VersionDriftNotice for a server behind the pin', () => {
  it('shows the update in progress, with its current step, and no action', () => {
    const html = render({
      drift: behind,
      upgrade: { state: 'updating', from: '0.10.0', to: '0.11.0' },
      progress: 'Backing up the database before updating switch-core 0.10.0 → 0.11.0…',
    });

    expect(text(html)).toContain('Updating switch-core 0.10.0 → 0.11.0…');
    expect(text(html)).toContain('Sessions on this server resume once the update finishes.');
    expect(text(html)).toContain('Backing up the database');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('<button');
    expect(text(html)).not.toContain('Restart to update');
  });

  it('shows a failed update with its error and a Retry button', () => {
    const html = render({
      drift: behind,
      upgrade: {
        state: 'failed',
        from: '0.10.0',
        to: '0.11.0',
        error: 'pg_dumpall failed: No space left on device',
      },
    });

    expect(text(html)).toContain('Updating switch-core 0.10.0 → 0.11.0 failed');
    expect(text(html)).toContain('pg_dumpall failed: No space left on device');
    expect(html).toContain('role="alert"');
    expect(html.match(/<button[^>]*>/g)).toHaveLength(1);
    expect(text(html)).toContain('Retry');
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""/);
  });

  it('disables Retry while another operation is in flight', () => {
    const html = render({
      drift: behind,
      upgrade: { state: 'failed', from: '0.10.0', to: '0.11.0', error: 'boom' },
      disabled: true,
    });

    expect(html).toMatch(/<button[^>]*\sdisabled=""/);
  });

  it('tells a stopped server it will update when started', () => {
    const html = render({
      drift: behind,
      upgrade: { state: 'pending', from: '0.10.0', to: '0.11.0' },
    });

    expect(text(html)).toContain('switch-core 0.11.0 is required');
    expect(text(html)).toContain('stopped on switch-core 0.10.0');
    expect(text(html)).toContain('Start and update');
  });

  it('never offers the old optional restart for a server that is behind', () => {
    const html = render({ drift: behind, upgrade: null });

    expect(text(html)).toContain('switch-core 0.11.0 is required');
    expect(text(html)).not.toContain('Restart to update');
    expect(html).not.toContain('<button');
  });
});

describe('VersionDriftNotice for the cases it does not upgrade', () => {
  it('still explains a downgrade with no action', () => {
    const html = render({
      drift: { deployed: '0.12.0', expected: '0.11.0', direction: 'downgrade' },
      upgrade: null,
    });

    expect(text(html)).toContain('This server is newer than Switch Console');
    expect(html).not.toContain('<button');
  });

  it('still reports an unreadable version with no action', () => {
    const html = render({
      drift: { deployed: null, expected: '0.11.0', direction: 'unreadable', reason: 'daemon down' },
      upgrade: null,
    });

    expect(text(html)).toContain("Can't tell which switch-core this is running");
    expect(text(html)).toContain('daemon down');
    expect(html).not.toContain('<button');
  });

  it('still offers a restart for an uncomparable version', () => {
    const html = render({
      drift: { deployed: 'nightly', expected: '0.11.0', direction: 'unknown' },
      upgrade: null,
    });

    expect(text(html)).toContain('Version mismatch');
    expect(text(html)).toContain('Restart to update');
  });

  it('renders nothing for a server in step', () => {
    expect(render({ drift: null, upgrade: null })).toBe('');
  });
});
