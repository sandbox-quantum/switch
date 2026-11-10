import type { Plugin } from "vite";

export interface DevRequest {
  socket: { remoteAddress?: string };
}

export interface DevResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body: string): void;
}

export function serveDevRoleAccounts(file: URL): (req: DevRequest, res: DevResponse) => Promise<void>;
export function devRoleAccounts(file: URL): Plugin;
