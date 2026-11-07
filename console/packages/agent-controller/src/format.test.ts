import { describe, expect, it } from 'vitest';
import {
  colors,
  formatDoctorChecks,
  formatEnrollSuccess,
  formatHelp,
  formatKeyValue,
  formatMark,
  formatSeparateUsersInstallSuccess,
  formatSeparateUsersUninstallSuccess,
  formatServiceInstallSuccess,
  formatServiceUninstallSuccess,
  formatStatusReport,
  formatTable,
  formatUpdateStatus,
  padVisible,
  shouldUseColor,
  stripAnsi,
  visibleLength,
} from './format';

describe('format utilities', () => {
  describe('shouldUseColor', () => {
    it('returns false when NO_COLOR is set to a non-empty string', () => {
      expect(shouldUseColor({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
      expect(shouldUseColor({ isTTY: true }, { NO_COLOR: 'true' })).toBe(false);
    });

    it('returns false when FORCE_COLOR is 0', () => {
      expect(shouldUseColor({ isTTY: true }, { FORCE_COLOR: '0' })).toBe(false);
    });

    it('returns true when FORCE_COLOR is 1, even if stream is not a TTY', () => {
      expect(shouldUseColor({ isTTY: false }, { FORCE_COLOR: '1' })).toBe(true);
    });

    it('falls back to stream.isTTY when no env overrides are present', () => {
      expect(shouldUseColor({ isTTY: true }, {})).toBe(true);
      expect(shouldUseColor({ isTTY: false }, {})).toBe(false);
      expect(shouldUseColor({}, {})).toBe(false);
    });
  });

  describe('stripAnsi and visibleLength', () => {
    it('strips ANSI escape codes and computes visible length', () => {
      const colored = colors.green(colors.bold('hello'));
      expect(stripAnsi(colored)).toBe('hello');
      expect(visibleLength(colored)).toBe(5);
    });
  });

  describe('padVisible', () => {
    it('pads styled string to target visible length without counting escape codes', () => {
      const styled = colors.bold('ok');
      const padded = padVisible(styled, 6);
      expect(visibleLength(padded)).toBe(6);
      expect(stripAnsi(padded)).toBe('ok    ');
    });
  });

  describe('formatMark', () => {
    it('produces 4-character visible marks in plain text', () => {
      expect(formatMark('ok', false)).toBe('ok  ');
      expect(formatMark('warn', false)).toBe('warn');
      expect(formatMark('fail', false)).toBe('FAIL');
      expect(formatMark('info', false)).toBe('info');
      for (const kind of ['ok', 'warn', 'fail', 'info'] as const) {
        expect(visibleLength(formatMark(kind, false))).toBe(4);
      }
    });

    it('produces 4-character visible marks with color', () => {
      for (const kind of ['ok', 'warn', 'fail', 'info'] as const) {
        const colored = formatMark(kind, true);
        expect(visibleLength(colored)).toBe(4);
        expect(stripAnsi(colored).trim().toLowerCase()).toBe(
          kind === 'fail' ? 'fail' : kind
        );
      }
    });
  });

  describe('formatTable', () => {
    it('aligns columns cleanly', () => {
      const table = formatTable(
        ['NAME', 'ID', 'STATUS'],
        [
          ['scout', 'agent-1', 'running'],
          ['long-agent-name', 'agent-2', 'stopped'],
        ],
        { indent: '  ' }
      );
      const lines = table.split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe('  NAME             ID       STATUS ');
      expect(lines[1]).toBe('  scout            agent-1  running');
      expect(lines[2]).toBe('  long-agent-name  agent-2  stopped');
    });
  });

  describe('formatKeyValue', () => {
    it('aligns keys with colons', () => {
      const text = formatKeyValue(
        [
          ['ID', 'controller-1'],
          ['Server URL', 'https://switch.example.com'],
          ['Status', 'Active'],
        ],
        { indent: '  ' }
      );
      expect(text).toBe(
        '  ID:          controller-1\n  Server URL:  https://switch.example.com\n  Status:      Active'
      );
    });
  });
});

describe('command formatters', () => {
  describe('formatDoctorChecks', () => {
    it('formats checks grouped into Machine, Enrollment & Server, and Providers sections', () => {
      const checks = [
        { name: 'Node', status: 'ok' as const, detail: 'v22.13.0' },
        { name: 'Platform', status: 'ok' as const, detail: 'linux' },
        {
          name: 'Enrollment',
          status: 'ok' as const,
          detail: 'Controller controller-1 ("box") on https://switch.example.com',
        },
        {
          name: 'claude',
          status: 'ok' as const,
          detail: 'Installed 2.1.0, authenticated: Signed in.',
        },
        { name: 'Service', status: 'ok' as const, detail: 'Installed and running' },
        { name: 'Version', status: 'ok' as const, detail: '0.2.0, the latest' },
      ];

      const formatted = formatDoctorChecks(checks, { useColor: false });
      expect(formatted).toContain('Machine');
      expect(formatted).toContain('Enrollment & Server');
      expect(formatted).toContain('Providers');
      expect(formatted).toContain('ok    claude');
      expect(formatted).toContain('ok    Node');
    });

    it('displays fixes indented when checks fail or warn', () => {
      const checks = [
        {
          name: 'Node',
          status: 'fail' as const,
          detail: 'v22.12.0; needs 22.13 or later',
          fix: 'Upgrade Node.js to 22.13 or later.',
        },
      ];

      const formatted = formatDoctorChecks(checks, { useColor: false });
      expect(formatted).toContain('FAIL  Node');
      expect(formatted).toContain('Fix: Upgrade Node.js to 22.13 or later.');
    });
  });

  describe('formatStatusReport', () => {
    it('formats an enrolled controller with assigned agents table', () => {
      const report = formatStatusReport(
        {
          dataDir: '/var/lib/switch',
          enrolled: true,
          controllerId: 'controller-1',
          name: 'worker-box',
          server: 'https://switch.example.com',
          enrolledAt: '2026-10-01T00:00:00Z',
          secretStore: 'file',
          relay: 'http://127.0.0.1:39231',
          assignment: {
            kind: 'saved',
            revision: 3,
            agents: [
              {
                name: 'scout',
                agentId: 'agent-1',
                provider: 'claude',
                desiredState: 'running',
                process: 'running',
                reason: null,
                detail: null,
                appliedRevision: 3,
              },
            ],
          },
        },
        { useColor: false }
      );

      expect(report).toContain('Controller');
      expect(report).toContain('ID:              controller-1');
      expect(report).toContain('Name:            worker-box');
      expect(report).toContain('Agents (1 agent assigned, revision 3)');
      expect(report).toContain('scout');
      expect(report).toContain('agent-1');
      expect(report).toContain('running');
    });

    it('formats a not-enrolled status clearly with fix guidance', () => {
      const report = formatStatusReport(
        { dataDir: '/tmp/test', enrolled: false },
        { useColor: false }
      );

      expect(report).toContain('Controller');
      expect(report).toContain('Not enrolled');
      expect(report).toContain('Run switch-agent-controller enroll');
    });
  });

  describe('formatEnrollSuccess', () => {
    it('formats enrollment confirmation with next steps', () => {
      const text = formatEnrollSuccess(
        {
          controllerId: 'controller-123',
          name: 'build-worker',
          server: 'https://switch.example.com',
          dataDir: '/var/lib/switch',
        },
        { useColor: false }
      );

      expect(text).toContain('ok    Enrolled as controller controller-123 ("build-worker")');
      expect(text).toContain('Data directory:  /var/lib/switch');
      expect(text).toContain('Next steps:');
      expect(text).toContain('switch-agent-controller install-service');
      expect(text).toContain('switch-agent-controller run');
    });
  });

  describe('formatServiceInstallSuccess and formatServiceUninstallSuccess', () => {
    it('formats service installation with notes', () => {
      const text = formatServiceInstallSuccess(
        '/etc/systemd/user/controller.service',
        ['Unit reloaded'],
        'Releases current link established',
        { useColor: false }
      );
      expect(text).toContain('Service installed and started: /etc/systemd/user/controller.service');
      expect(text).toContain('• Unit reloaded');
      expect(text).toContain('• Releases current link established');
    });

    it('formats service uninstallation', () => {
      const removed = formatServiceUninstallSuccess(true, '/var/lib/releases', { useColor: false });
      expect(removed).toContain('Stopped and removed the service.');
      expect(removed).toContain('Removed the releases installed for itself');

      const notInstalled = formatServiceUninstallSuccess(false, null, { useColor: false });
      expect(notInstalled).toContain('No service was installed.');
    });

    it('formats separate users installation and uninstallation', () => {
      const installed = formatSeparateUsersInstallSuccess(['Users created: 16'], { useColor: false });
      expect(installed).toContain('Agents now run as users of their own.');
      expect(installed).toContain('• Users created: 16');

      const uninstalled = formatSeparateUsersUninstallSuccess(['Cleaned units'], { useColor: false });
      expect(uninstalled).toContain('Removed the setup for agents as users of their own.');
      expect(uninstalled).toContain('• Cleaned units');
    });
  });

  describe('formatUpdateStatus', () => {
    it('formats different update states', () => {
      expect(formatUpdateStatus({ kind: 'none-published' }, { useColor: false })).toContain(
        'No switch-agent-controller release is published yet.'
      );
      expect(formatUpdateStatus({ kind: 'latest', version: '0.2.0' }, { useColor: false })).toContain(
        'This is the latest release, 0.2.0.'
      );
      const avail = formatUpdateStatus(
        { kind: 'available', current: '0.1.0', latest: '0.2.0' },
        { useColor: false }
      );
      expect(avail).toContain('Update available: 0.2.0 (currently running 0.1.0)');
      expect(avail).toContain('Install with: switch-agent-controller update');
    });
  });

  describe('formatHelp', () => {
    it('preserves text when color is disabled', () => {
      const raw = 'Usage: test\nCommands:\n  run   start';
      expect(formatHelp(raw, { useColor: false })).toBe(raw);
    });

    it('styles section headers when color is enabled', () => {
      const raw = 'Usage:\nCommands:\n  run   start';
      const styled = formatHelp(raw, { useColor: true });
      expect(stripAnsi(styled)).toBe(raw);
      expect(styled).not.toBe(raw);
    });
  });
});
