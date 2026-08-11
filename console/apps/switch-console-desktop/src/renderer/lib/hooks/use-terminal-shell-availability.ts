import { useQuery } from '@tanstack/react-query';
import type { TerminalShellAvailability } from '@shared/core/terminals/terminal-settings';

export const DEFAULT_TERMINAL_SHELL_AVAILABILITY: TerminalShellAvailability[] = [];

// Shell-availability detection has no RPC surface in Switch Console — every session
// runs in the location dir with the system shell. Return the empty default so the
// settings UI degrades gracefully (only the system shell is selectable).
export function useTerminalShellAvailability(options: { enabled?: boolean } = {}) {
  return useQuery<TerminalShellAvailability[]>({
    queryKey: ['terminal-shell-availability', 'local'],
    queryFn: () => Promise.resolve(DEFAULT_TERMINAL_SHELL_AVAILABILITY),
    staleTime: 30_000,
    enabled: options.enabled ?? true,
  });
}
