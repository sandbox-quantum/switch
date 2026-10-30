import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  assignmentSchema,
  controllerConnectionRequestSchema,
  controllerPongSchema,
  controllerConnectionResponseSchema,
  controllerInfoRequestSchema,
  controllerInfoResponseSchema,
  credentialRotateResponseSchema,
  enrollRequestSchema,
  enrollResponseSchema,
  errorEnvelopeSchema,
  operationListSchema,
  operationResultSchema,
  operationSchema,
  statusReportSchema,
  statusResponseSchema,
  tokenRequestSchema,
  tokenResponseSchema,
  decisionRequestFrameSchema,
  decisionResultSchema,
  decisionStatusSchema,
} from './schemas';
import { STREAM_FRAME_SCHEMAS } from './stream';
import { OFF_DECISION_STATUS } from './testing/fake-decision';

/**
 * Core's contract fixtures: one JSON file per wire message. Core checks its
 * real responses against them; here each is parsed with the schema the
 * controller reads or writes it with.
 */
const FIXTURES = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'core',
  'tests',
  'switch_core',
  'fixtures',
  'agent_controllers'
);

/**
 * Which schema reads which fixture, by file name. A fixture not listed here
 * fails the test, so a message added on one side is noticed on the other.
 */
const SCHEMA_FOR: Record<string, z.ZodType> = {
  'assignment_response.json': assignmentSchema,
  'controller_pong.json': controllerPongSchema,
  'controller_connection_request.json': controllerConnectionRequestSchema,
  'controller_connection_response.json': controllerConnectionResponseSchema,
  'controller_info_request.json': controllerInfoRequestSchema,
  'controller_info_response.json': controllerInfoResponseSchema,
  'credential_rotate_response.json': credentialRotateResponseSchema,
  'enroll_request.json': enrollRequestSchema,
  'enroll_response.json': enrollResponseSchema,
  'error_response.json': errorEnvelopeSchema,
  'operation.json': operationSchema,
  'operation_result_failed.json': operationResultSchema,
  'operation_result_succeeded.json': operationResultSchema,
  'operations_response.json': operationListSchema,
  'status_request.json': statusReportSchema,
  'status_response.json': statusResponseSchema,
  'token_request.json': tokenRequestSchema,
  'token_response.json': tokenResponseSchema,
};

/** `stream_frames.json` is a list of `{event, data}`; each is read as the stream reads it. */
const streamFramesSchema = z.array(
  z.object({ event: z.string(), data: z.unknown() }).superRefine((frame, context) => {
    const schema = (STREAM_FRAME_SCHEMAS as Record<string, z.ZodType>)[frame.event];
    if (!schema) {
      context.addIssue({ code: 'custom', message: `No schema for stream event '${frame.event}'.` });
      return;
    }
    const result = schema.safeParse(frame.data);
    if (!result.success)
      context.addIssue({ code: 'custom', message: `${frame.event}: ${result.error.message}` });
  })
);
SCHEMA_FOR['stream_frames.json'] = streamFramesSchema;

const fixtureFiles = existsSync(FIXTURES)
  ? readdirSync(FIXTURES).filter((name) => name.endsWith('.json'))
  : [];

describe('Core contract fixtures', () => {
  it.skipIf(!existsSync(FIXTURES))(
    `parse with the controller's schemas${existsSync(FIXTURES) ? '' : ` (skipped: ${FIXTURES} does not exist)`}`,
    () => {
      expect(fixtureFiles.length).toBeGreaterThan(0);
      const unmatched = fixtureFiles.filter((file) => !(file in SCHEMA_FOR));
      expect(unmatched, 'fixtures with no schema registered in SCHEMA_FOR').toEqual([]);
      const failures: string[] = [];
      for (const file of fixtureFiles) {
        const result = SCHEMA_FOR[file]!.safeParse(
          JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'))
        );
        if (!result.success) failures.push(`${file}: ${result.error.message}`);
      }
      expect(failures).toEqual([]);
    }
  );

  it.skipIf(!existsSync(FIXTURES))('covers every stream event the controller handles', () => {
    const frames = JSON.parse(readFileSync(join(FIXTURES, 'stream_frames.json'), 'utf8')) as {
      event: string;
    }[];
    expect(new Set(frames.map((frame) => frame.event))).toEqual(
      new Set(Object.keys(STREAM_FRAME_SCHEMAS))
    );
  });
});

const definition = {
  name: 'scout',
  display_name: 'Scout',
  icon_url: null,
  provider: 'claude',
  model: null,
  advanced_config: {},
  instructions: '',
  auto_approve: false,
  directory: null,
  isolation: 'shared',
};

describe('received messages', () => {
  it('ignores fields it does not know', () => {
    const parsed = assignmentSchema.parse({
      revision: 1,
      future_field: true,
      agents: [
        {
          agent_id: 'a',
          revision: 1,
          desired_state: 'running',
          definition: { ...definition, skills: [] },
        },
      ],
    });
    expect(parsed).not.toHaveProperty('future_field');
    expect(parsed.agents[0]!.definition).not.toHaveProperty('skills');
  });

  it('reads a definition without auto_mode, from a server older than the setting, as off', () => {
    const parsed = assignmentSchema.parse({
      revision: 1,
      agents: [{ agent_id: 'a', revision: 1, desired_state: 'running', definition }],
    });
    expect(parsed.agents[0]!.definition.auto_mode).toBe(false);
    const on = assignmentSchema.parse({
      revision: 1,
      agents: [
        {
          agent_id: 'a',
          revision: 1,
          desired_state: 'running',
          definition: { ...definition, auto_mode: true },
        },
      ],
    });
    expect(on.agents[0]!.definition.auto_mode).toBe(true);
  });

  it('reads an enum value it does not know as unknown', () => {
    const parsed = assignmentSchema.parse({
      revision: 1,
      agents: [{ agent_id: 'a', revision: 1, desired_state: 'paused', definition }],
    });
    expect(parsed.agents[0]!.desired_state).toBe('unknown');
  });

  it('keeps an unknown provider as text so only that agent fails', () => {
    const parsed = assignmentSchema.parse({
      revision: 1,
      agents: [
        {
          agent_id: 'a',
          revision: 1,
          desired_state: 'running',
          definition: { ...definition, provider: 'gemini' },
        },
      ],
    });
    expect(parsed.agents[0]!.definition.provider).toBe('gemini');
  });

  it('reads the error envelope', () => {
    expect(
      errorEnvelopeSchema.parse({
        error: { code: 'controller_revoked', message: 'gone', retryable: false },
      }).error.code
    ).toBe('controller_revoked');
  });
});

describe('status report', () => {
  const report = {
    seq: 1,
    observed_at: '2026-01-01T00:00:00Z',
    controller: {
      version: '0.1.0',
      protocol: 2,
      assignment_revision: 0,
      updated_by: 'self',
      capabilities: ['decision.v1'],
    },
    machine: {
      platform: { os: 'linux', arch: 'x64', os_version: '6.1' },
      disk_free_bytes: 1,
      disk_total_bytes: 2,
      mem_free_bytes: 1,
      mem_total_bytes: 2,
      sessions_running: 0,
      sessions_max: 0,
      workspaces_dir: '/data/workspaces',
    },
    providers: [],
    tools: [],
    agents: [
      {
        agent_id: 'a',
        applied_revision: 1,
        process: 'failed',
        attached: false,
        sessions: { active: 0, ids: [] },
        restarts_10m: 0,
        oom_kills: 0,
        directory: null,
        since: '2026-01-01T00:00:00Z',
        reason: 'internal',
      },
    ],
    decision: OFF_DECISION_STATUS,
  };

  it('accepts a full snapshot', () => {
    expect(statusReportSchema.safeParse(report).success).toBe(true);
  });

  it('requires the workspaces directory and each agent’s directory', () => {
    const { workspaces_dir: _dir, ...machine } = report.machine;
    expect(statusReportSchema.safeParse({ ...report, machine }).success).toBe(false);
    const { directory: _directory, ...agent } = report.agents[0]!;
    expect(statusReportSchema.safeParse({ ...report, agents: [agent] }).success).toBe(false);
  });

  it('requires a reason for a failed agent', () => {
    const { reason: _reason, ...agent } = report.agents[0]!;
    expect(statusReportSchema.safeParse({ ...report, agents: [agent] }).success).toBe(false);
  });

  it('says why the controller is not on the release Switch names, when it is not', () => {
    expect(
      statusReportSchema.safeParse({
        ...report,
        update: { target: '0.31.0', state: 'failed', problem: 'npm install failed' },
      }).success
    ).toBe(true);
    expect(
      statusReportSchema.safeParse({ ...report, update: { target: '0.31.0', state: 'done' } })
        .success
    ).toBe(false);
  });
});

describe('decisions on this machine', () => {
  it('reads the assignment’s decision, and its absence as none', () => {
    expect(assignmentSchema.parse({ revision: 1, agents: [] }).decision ?? null).toBeNull();
    expect(
      assignmentSchema.parse({ revision: 2, agents: [], decision: null }).decision ?? null
    ).toBeNull();
    expect(
      assignmentSchema.parse({
        revision: 3,
        agents: [],
        decision: { revision: 3, model: 'qwen3.5-4b-q4_k_m' },
      }).decision
    ).toEqual({ revision: 3, model: 'qwen3.5-4b-q4_k_m' });
  });

  it('reads a decision request, keeping its payload as it came', () => {
    const payload = { messages: [{ role: 'user', content: 'x' }], max_tokens: 1, extra: [1] };
    const frame = decisionRequestFrameSchema.parse({
      request_id: 'r1',
      kind: 'llamacpp',
      model: 'qwen3.5-4b-q4_k_m',
      payload,
      deadline_ms: 2000,
      unknown_field: true,
    });
    expect(frame.payload).toEqual(payload);
    expect(decisionRequestFrameSchema.parse({ ...frame, kind: 'something-new' }).kind).toBe(
      'unknown'
    );
    expect(decisionRequestFrameSchema.safeParse({ ...frame, request_id: '' }).success).toBe(false);
  });

  it('writes results as the contract says', () => {
    expect(
      decisionResultSchema.safeParse({
        type: 'decision.result',
        request_id: 'r1',
        ok: true,
        body: { choices: [] },
        model_ms: 420,
      }).success
    ).toBe(true);
    expect(
      decisionResultSchema.safeParse({
        type: 'decision.result',
        request_id: 'r1',
        ok: false,
        error: { code: 'busy', message: 'busy' },
      }).success
    ).toBe(true);
    expect(
      decisionResultSchema.safeParse({
        type: 'decision.result',
        request_id: 'r1',
        ok: false,
        error: { code: 'machine_offline', message: 'not a controller code' },
      }).success
    ).toBe(false);
  });

  it('needs a reason for a failed decision model', () => {
    expect(decisionStatusSchema.safeParse(OFF_DECISION_STATUS).success).toBe(true);
    expect(
      decisionStatusSchema.safeParse({ ...OFF_DECISION_STATUS, state: 'failed', model: 'm' })
        .success
    ).toBe(false);
    expect(
      decisionStatusSchema.safeParse({
        ...OFF_DECISION_STATUS,
        state: 'failed',
        model: 'm',
        reason: 'checksum_mismatch',
      }).success
    ).toBe(true);
  });
});

describe('status response', () => {
  it('keeps controller_release as sent, absent included, whatever its shape', () => {
    const base = { assignment_revision: 3, report_within_s: 60 };
    expect(statusResponseSchema.parse(base).controller_release).toBeUndefined();
    expect(
      statusResponseSchema.parse({ ...base, controller_release: null }).controller_release
    ).toBeNull();
    const release = { version: '0.31.0', url: 'https://example.invalid/a.tgz', sha256: 'f' };
    expect(
      statusResponseSchema.parse({ ...base, controller_release: release }).controller_release
    ).toEqual(release);
    expect(statusResponseSchema.safeParse({ ...base, controller_release: 42 }).success).toBe(true);
  });
});
