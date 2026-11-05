import { definePlugin, registerPluginBehavior } from '@switch-console/core/agents/plugins'
import { npmDependency } from '@switch-console/core/agents/plugins/helpers'
import { icon } from './icon'

const dependency = npmDependency({ id: 'junie', package: '@jetbrains/junie' })

export const plugin = definePlugin(
  {
    id: 'junie',
    name: 'Junie',
    description: 'JetBrains Junie over ACP with model selection, tool approvals and resumable conversations.',
    websiteUrl: 'https://junie.jetbrains.com/docs/junie-cli.html',
    cliLabel: 'Junie CLI',
  },
  {
    autoApprove: { kind: 'supported' },
    effort: { kind: 'none' },
    hostDependency: {
      ...dependency,
      installCommands: {
        ...dependency.installCommands,
        linux: [{
          method: 'npm',
          command: 'npm install -g --prefix "$HOME/.local" @jetbrains/junie',
          updateCommand: 'npm install -g --prefix "$HOME/.local" @jetbrains/junie',
          uninstallCommand: 'npm uninstall -g --prefix "$HOME/.local" @jetbrains/junie',
          recommended: true,
        }],
      },
    },
    mcp: { kind: 'none' },
    models: { kind: 'none' },
    plugins: { kind: 'none' },
    prompt: { kind: 'none' },
    sessions: { kind: 'resumable' },
    repoAgents: { kind: 'none' },
  },
  { icon }
)

export const provider = registerPluginBehavior(plugin, {
  prompt: {
    buildCommand: () => {
      throw new Error('Junie runs through the ACP session host.')
    },
  },
})
