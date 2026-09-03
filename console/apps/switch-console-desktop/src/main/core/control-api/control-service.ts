import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IDisposable, IInitializable } from '@switch-console/shared';
import { app } from 'electron';
import { getAgentById } from '@main/core/agents/getAgentById';
import { getAgents } from '@main/core/agents/getAgents';
import { getSession } from '@main/core/sessions/operations/getSession';
import { sessionService } from '@main/core/sessions/session-service';
import { log } from '@main/lib/logger';
import { ControlServer, readJsonBody, sendJson } from './control-server';

const TOKEN_FILENAME = 'control-api.json';

class ControlService implements IInitializable, IDisposable {
  private server = new ControlServer(log);

  async initialize(): Promise<void> {
    this.registerRoutes();
    await this.server.start();
    try {
      this.writeTokenFile();
    } catch (err) {
      this.server.stop();
      throw err;
    }
    log.info('ControlService: initialized', { port: this.server.getPort() });
  }

  dispose(): void {
    this.server.stop();
    this.removeTokenFile();
  }

  getPort(): number {
    return this.server.getPort();
  }

  getToken(): string {
    return this.server.getToken();
  }

  private registerRoutes(): void {
    this.server.route('GET', '/agents', async (_req, res) => {
      const agents = await getAgents();
      sendJson(res, 200, { agents });
    });

    this.server.route('GET', '/agents/:agentId', async (_req, res, params) => {
      const agent = await getAgentById(params['agentId']!);
      if (!agent) {
        sendJson(res, 404, { error: 'agent not found' });
        return;
      }
      sendJson(res, 200, { agent });
    });

    this.server.route('GET', '/agents/:agentId/sessions', async (_req, res, params) => {
      const agent = await getAgentById(params['agentId']!);
      if (!agent) {
        sendJson(res, 404, { error: 'agent not found' });
        return;
      }
      const allSessions = await sessionService.getSessions();
      const agentSessions = allSessions.filter((s) => s.agentId === agent.id);
      sendJson(res, 200, { sessions: agentSessions });
    });

    this.server.route('POST', '/agents/:agentId/sessions', async (req, res, params) => {
      const agent = await getAgentById(params['agentId']!);
      if (!agent) {
        sendJson(res, 404, { error: 'agent not found' });
        return;
      }
      let body: Record<string, unknown> = {};
      try {
        body = (await readJsonBody(req)) as Record<string, unknown>;
      } catch {
        sendJson(res, 400, { error: 'invalid request body' });
        return;
      }
      const title = typeof body['title'] === 'string' ? body['title'] : 'API session';
      const result = await sessionService.createSession({
        id: crypto.randomUUID(),
        agentId: agent.id,
        title,
        startSource: 'auto',
      });
      if (!result.success) {
        sendJson(res, 422, { error: result.error.type });
        return;
      }
      sendJson(res, 201, { session: result.data });
    });

    this.server.route(
      'DELETE',
      '/agents/:agentId/sessions/:sessionId',
      async (_req, res, params) => {
        const agent = await getAgentById(params['agentId']!);
        if (!agent) {
          sendJson(res, 404, { error: 'agent not found' });
          return;
        }
        const session = await getSession(params['sessionId']!);
        if (!session || session.agentId !== agent.id) {
          sendJson(res, 404, { error: 'session not found' });
          return;
        }
        const teardownResult = await sessionService.teardown(session.id, 'terminate');
        if (!teardownResult.success) {
          sendJson(res, 500, { error: teardownResult.error.type });
          return;
        }
        sendJson(res, 200, { ok: true });
      }
    );

    this.server.route('POST', '/agents/:agentId/sidecar/restart', async (_req, res, params) => {
      const agent = await getAgentById(params['agentId']!);
      if (!agent) {
        sendJson(res, 404, { error: 'agent not found' });
        return;
      }
      try {
        const { sidecarController } = await import('@main/core/sidecar/controller');
        const status = await sidecarController.restart(agent.id);
        sendJson(res, 200, { status });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
    });

    this.server.route('POST', '/agents/:agentId/sidecar/stop', async (_req, res, params) => {
      const agent = await getAgentById(params['agentId']!);
      if (!agent) {
        sendJson(res, 404, { error: 'agent not found' });
        return;
      }
      try {
        const { sidecarController } = await import('@main/core/sidecar/controller');
        const status = await sidecarController.stop(agent.id);
        sendJson(res, 200, { status });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
    });

    this.server.route('GET', '/agents/:agentId/sidecar/status', async (_req, res, params) => {
      const agent = await getAgentById(params['agentId']!);
      if (!agent) {
        sendJson(res, 404, { error: 'agent not found' });
        return;
      }
      try {
        const { sidecarController } = await import('@main/core/sidecar/controller');
        const status = await sidecarController.getStatus(agent.id);
        sendJson(res, 200, { status });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
    });
  }

  private tokenFilePath(): string {
    return path.join(app.getPath('userData'), TOKEN_FILENAME);
  }

  private writeTokenFile(): void {
    const filePath = this.tokenFilePath();
    const data = JSON.stringify({ port: this.server.getPort(), token: this.server.getToken() });
    fs.writeFileSync(filePath, data, { mode: 0o600 });
  }

  private removeTokenFile(): void {
    try {
      fs.unlinkSync(this.tokenFilePath());
    } catch {
      // already gone
    }
  }
}

export const controlService = new ControlService();
