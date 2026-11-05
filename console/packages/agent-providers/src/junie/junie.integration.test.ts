import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { checkAcpSignIn } from '../acp/acp-adapter'
import { readiness } from '../readiness'
import { describeConformance, echoMcpServerSpec } from '../testing/index'
import { createJunieAdapter, junieAcp } from './junie-acp'

const binaryPath = process.env.JUNIE_BINARY ?? 'junie'
const env = Object.fromEntries((junieAcp.inheritEnv ?? [])
  .filter((name) => process.env[name] !== undefined)
  .map((name) => [name, process.env[name]!]))
const unavailableReason = async () => {
  const probe = spawnSync(binaryPath, ['--version'], { encoding: 'utf8', timeout: 15_000 })
  return probe.error || probe.status !== 0 ? 'Junie CLI is not available on this execution host' : null
}

describeConformance('junie', {
  createAdapter: async () => createJunieAdapter({ binaryPath }),
  unavailableReason,
  mcpServers: { echo: echoMcpServerSpec() },
  env,
})

it('discovers and reselects the configured free custom model without a model prompt', async (ctx) => {
  if (await unavailableReason()) return ctx.skip('Junie CLI unavailable')
  if (env.JUNIE_MODEL !== 'custom:openrouter-free') return ctx.skip('Requires the isolated free-only profile')
  const cwd = await mkdtemp(join(tmpdir(), 'junie-model-'))
  const adapter = createJunieAdapter({ binaryPath })
  try {
    await adapter.startSession({
      sessionId: 'model-metadata', cwd, runtimeMode: 'approval-required', env,
      mcpServers: {}, connectorMcpServers: [],
    })
    const models = await adapter.listModels('model-metadata')
    expect(models.some((model) => model.id === env.JUNIE_MODEL)).toBe(true)
    await adapter.setModel('model-metadata', { id: env.JUNIE_MODEL })
  } finally {
    await adapter.stopAll()
    await rm(cwd, { recursive: true, force: true })
  }
}, 60_000)

it('advertises the HTTP MCP transport required by Switch room tools', async (ctx) => {
  if (await unavailableReason()) return ctx.skip('Junie CLI unavailable')
  const cwd = await mkdtemp(join(tmpdir(), 'junie-http-'))
  try {
    await checkAcpSignIn({
      ...junieAcp,
      checkSignIn: async ({ handshake }) => {
        const metadata = await handshake()
        console.info('Junie ACP capabilities:', JSON.stringify(metadata.agentCapabilities))
        expect(metadata.agentCapabilities?.mcpCapabilities?.http).toBe(true)
        return readiness('unknown', 'Metadata check only')
      },
    }, { binaryPath, cwd, env })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}, 30_000)
