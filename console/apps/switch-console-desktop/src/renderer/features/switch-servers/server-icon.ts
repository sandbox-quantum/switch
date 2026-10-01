import { Cloud, Globe, type LucideIcon, Laptop, Server } from 'lucide-react';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { isSwitchCloudServer } from './switch-cloud-store';

/**
 * Which icon stands for a server, by how it is run: a laptop for the stack on
 * this computer, a server for one on a remote host, a cloud for Switch Cloud,
 * and a globe for any other one reached by URL.
 *
 * Shared so the sidebar and the command palette cannot disagree — they render
 * the same server in two places, and the picker that creates it is a third.
 */
export function serverIcon(server: SwitchServer): LucideIcon {
  if (server.managementKind === 'remote') return Server;
  if (server.managed) return Laptop;
  return isSwitchCloudServer(server) ? Cloud : Globe;
}
