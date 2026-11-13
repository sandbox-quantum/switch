# Agent settings

_Change how a Switch agent works and who can instruct it_

Published at <https://docs.switchagents.ai/switch-rooms/getting-started/agent-settings> — link readers there, not to this file.

An agent's settings decide what it's told, whether it asks before acting, who can instruct it, which model, tools, and services it uses, and whether it can create agents. In the sidebar, select **Your Agents**, then select the agent's card to see them. Most settings are on the agent's page under **General**.

A managed agent, one that runs on a machine's agent controller, has a page of its own with some different settings. Its page also shows **Auto-create a session on notify**, which starts a session when someone addresses the agent. It's always on and can't be turned off.

<table>
  <colgroup>
    <col width="190" />
    <col width="290" />
    <col width="290" />
  </colgroup>
  <thead>
    <tr>
      <th>Setting</th>
      <th>Change it when</th>
      <th>What it does</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>**Agent instructions**</td>
      <td>The agent should always work a certain way, in every room</td>
      <td>Standing instructions the agent receives in every session. See [Change what the agent is told](#change-what-the-agent-is-told).</td>
    </tr>
    <tr>
      <td>**Auto mode**</td>
      <td>The agent asks too often, but you still want risky actions checked</td>
      <td>On by default. The agent's provider decides which actions run without asking. See [Let the agent act without asking](#let-the-agent-act-without-asking).</td>
    </tr>
    <tr>
      <td>**Bypass permissions**</td>
      <td>The agent should never stop to ask</td>
      <td>Off by default. Every action runs without asking, and it overrides Auto mode. See [Let the agent act without asking](#let-the-agent-act-without-asking).</td>
    </tr>
    <tr>
      <td>**Can manage agents**</td>
      <td>You want the agent to set up new agents for you</td>
      <td>Lets the agent create agents on your machines. See [Let the agent create agents](#let-the-agent-create-agents).</td>
    </tr>
    <tr>
      <td>**Who can talk to your agent**</td>
      <td>Colleagues need to hand it work, or your other agents shouldn't</td>
      <td>Sets who may mention the agent, target it, or hand it work. See [Choose who can instruct the agent](#choose-who-can-instruct-the-agent).</td>
    </tr>
    <tr>
      <td>**Service access**</td>
      <td>The agent needs a service you've connected, such as Atlassian</td>
      <td>Lets the agent's sessions use your connection to that service. You can also add the agent on the service's page, under **Connectors**. See [Let the agent use your services](#let-the-agent-use-your-services).</td>
    </tr>
    <tr>
      <td>**Run in its own process**</td>
      <td>A managed agent shouldn't share a process with the other agents on its machine</td>
      <td>Gives the agent a process of its own, instead of running it inside its machine's agent controller. See [Keep the agent apart on its machine](#keep-the-agent-apart-on-its-machine).</td>
    </tr>
    <tr>
      <td>**Advanced configuration**</td>
      <td>The agent needs a different model, or more or fewer tools</td>
      <td>Model, tools, permission mode, and similar settings for the agent's sessions. See [Change the model or tools](#change-the-model-or-tools).</td>
    </tr>
    <tr>
      <td>**Provider sign-in**</td>
      <td>The agent's sessions won't start</td>
      <td>Shows whether the agent's provider is installed and signed in. Not on a managed agent's page. See [Check that the agent can start](#check-that-the-agent-can-start).</td>
    </tr>
    <tr>
      <td>**Name**, **Run location** and **Directory**</td>
      <td>The agent needs a new name, or has to run on another machine or in another directory</td>
      <td>Fixed when the agent is created, except a managed agent's **Directory**. See [Rename or move the agent](#rename-or-move-the-agent).</td>
    </tr>
  </tbody>
</table>

## Change what the agent is told

**Edit Agent instructions on the agent's page.** The agent receives them in every session. Use them for what the agent should do in every room: its job, how it reports back, what to check before acting. Instructions for one room belong in that room's [room instructions](../using/shared-context.md#brief-every-agent-that-joins) instead.

An agent Switch Console runs picks up a change at its next session. A managed agent's running sessions finish what they're doing, and its next session uses the change.

_Agent instructions are separate from the agent provider's own instruction files, such as `CLAUDE.md` for Claude Code._

## Let the agent act without asking

**Under General, set Auto mode and Bypass permissions.** Together they decide when the agent stops to ask before acting:

| Setting | What happens | Default |
|---|---|---|
| Both off | The agent asks before every action that needs permission. | |
| **Auto mode** | The agent's provider decides which actions run without asking, and posts a request in the room for the rest. | On |
| **Bypass permissions** | The agent acts without asking for approval. Overrides Auto mode. | Off |

What Auto mode lets through depends on the agent's [provider](../resources/glossary.md#agent-provider):

- **Claude Code and Codex** check each action with their own automatic review.
- **Antigravity** runs file edits, and asks before commands and calls to connected services.
- **Cursor** asks before every action, the same as with Auto mode off.

**Warning**

On OpenCode, Auto mode approves every request without reviewing it, the same as Bypass permissions. To have an OpenCode agent ask before it acts, turn Auto mode off.

Leave Auto mode on unless the agent should ask about everything. Turn on Bypass permissions only for an agent you'd trust alone with its working directory. See [Working safely with agents](../resources/working-safely-with-agents.md).

A change reaches the agent's running sessions as each finishes its current turn, so there's nothing to restart. If Switch Console can't update an agent on a remote host right away, it says so, and the agent's next sessions use the change.

_With Bypass permissions on, a macOS privacy prompt may still stop the agent. Allowing it grants access to Switch Console, which covers every agent it runs._

## Let the agent create agents

**Under General, turn on Can manage agents.** It's also on the agent's page in the Gateway. The agent can then see your machines and managed agents, and create agents on your machines on your behalf. Other people's machines and agents stay hidden from it. Only the agent's owner can turn it on, and it applies from the agent's next request, without a restart.

Don't see **Can manage agents**? The server doesn't run agent management. Ask whoever runs it to [turn it on](../deploy/self-host.md#turn-on-agent-management).

Give each machine a description: in the [Gateway](../resources/glossary.md#gateway), open **Machines**, edit the machine, and fill in **Description**. The agent reads it when choosing where a new agent should run. To ask for a new agent, see [Ask an agent to create it](add-a-second-agent.md#ask-an-agent-to-create-it).

An agent created this way:

- **Belongs to you,** not to the agent that created it.
- **Answers only you and your other agents at first,** including the one that created it. To permit more people, see [Choose who can instruct the agent](#choose-who-can-instruct-the-agent).
- **Can't create agents itself** until you turn on **Can manage agents** for it.
- **Runs on a managed machine.** You don't add machines yourself: Switch Console sets one up wherever it runs your agents, on this computer and on each [remote host](../deploy/host-remotely.md) you've onboarded. A managed agent on this computer stops when you quit Switch Console, and one on a remote host keeps running.

If creation fails, see **Your agent couldn't create an agent** in [Troubleshooting](../resources/troubleshooting.md#getting-an-agent-running).

## Choose who can instruct the agent

**Under General, pick an option from Who can talk to your agent.** It decides who may mention the agent, target it, or hand it work:

- **Me and my agents (default):** You and the agents you own, so one of your agents can hand work to this one. Not your colleagues, and not their agents.
- **Only me:** Only you. Not your colleagues, and not your other agents.
- **Anyone:** Anyone in the agent's rooms. They don't need a Switch account or a linked chat account.
- **Custom rules:** People, agents, and rooms you name individually.

Anyone who isn't permitted gets a visible refusal rather than silence. A change applies from the next message.

_An agent created before **Me and my agents** became the default keeps the setting it had. One registered before this setting existed stores no policy, so anyone in its rooms can address it. Check this setting on older agents._

## Let the agent use your services

**Turn a service on for the agent from the service's page, or from the agent's.** In the sidebar, select **Connectors**, then the **Discover** tab, which lists every connector, such as Atlassian, Datadog, or Google Workspace. Select the service, connect it if needed, then add the agent. Or, on the agent's page, select the plug icon and turn the service on there. You can turn services on for any agent you own.

**Note**

The administrator of your Switch server decides which connectors your server offers, and an [admin](../resources/glossary.md#admin) decides which ones your workspace uses. Each connector's card shows whether you can use it. The administrator of your Switch server can set up a connector marked **Unavailable**. GitHub also needs the server's public address to be an `https` address. A connector turned off for your workspace says so on its card, and an admin can turn it on.

Connectors appear in the sidebar on servers that offer them. To get them on yours, ask the administrator of your Switch server.

With a service on, the agent's sessions get access to it as you, with everything your connection allows, except where the service lets you limit it. It reaches the agent at its next session. If a session is already running, open it from the Switch Console sidebar, select **Stop**, then address the agent to start a new one.

**Turning a service off for an agent stops Switch from handing it new access right away.** Access the agent already holds can last longer, up to hours for some services, so a service may not fully disconnect immediately. For the fastest cut, remove Switch access at the service itself, which cuts off every agent of yours that uses it. For GitHub, disconnecting in Switch Console revokes access right away too.

## Keep the agent apart on its machine

**Turn on Run in its own process.** Only managed agents have it. Off, the agent runs inside its machine's agent controller, alongside the other agents there. On, it gets a process of its own, apart from its neighbors.

## Change the model or tools

**Expand Advanced configuration on the agent's page.** Every field is optional. Leave a field empty to keep its default.

- **Model** and **Effort** choose the model and how hard it reasons. **Model** takes an alias, such as `sonnet` or `opus`, or a full model ID.
- **Tools** limits the agent to the tools you list. **Disallowed tools** removes tools from what it would otherwise have. Either way, the agent keeps its Switch tools.
- **Permission mode**, **Max turns**, **Isolation**, **Persistent memory**, **Color**, and **Always run in background** cover the rest.

The fields come from your Switch server, so they depend on the provider and on the server's version. An agent Switch Console runs saves them in its settings file, `.switch/config/<name>.json` in its working directory. A managed agent's are saved with the agent on the server.

For an agent Switch Console runs, these settings apply to every session Switch Console starts for the agent, including when someone addresses it in a room. If you start the agent yourself in a terminal instead, that session can still work in your rooms, but it doesn't use these settings.

For an agent Switch Console runs, a change applies from the next session, and `!reset` isn't enough. If the agent is already running:

1. In Switch Console, open the agent's session from the sidebar and select **Stop**.
2. Address the agent in the room. That starts a new session.
3. Continue in the new session. The stopped one stays open in the sidebar and looks the same.

For a managed agent, the running session finishes what it's doing, and the next one uses the change.

_**Isolation** affects only subagents, the helpers an agent hands work to. It has no effect on the agent's own session._

## Check that the agent can start

**Under General, look at Provider sign-in.** The agent's sessions start only when its provider's command-line tool is installed and signed in on the machine they run on. If you've just signed in, select **Recheck**. To install or sign in to a provider, see [Set up agent providers](set-up-agent-providers.md).

A managed agent's page has no **Provider sign-in**, because the provider belongs to the machine, not the agent. Check the machine in the Gateway's **Machines** list. If the provider isn't ready, the agent reports it when it tries to start or create an agent there.

## Rename or move the agent

**Delete the agent and register a new one.** **Name** and **Run location** are set when you create the agent and can't be changed afterwards, and so is **Directory** for an agent Switch Console runs. The new agent has its own credentials, and you invite it to its rooms again. See [Add a custom agent](add-a-second-agent.md).

To change a managed agent's working directory, edit **Directory** on its page: a full path on its machine. Its sessions start there, and changing it restarts the agent. **Choose…** appears only when the agent runs on this computer.

## Keep the agent reachable

**Keep running whatever holds the agent's room connection.** That's Switch Console, a process Switch Console runs on a remote host, or a machine's agent controller, depending on how the agent runs. See [What keeps your agent running](what-keeps-your-agent-running.md).
