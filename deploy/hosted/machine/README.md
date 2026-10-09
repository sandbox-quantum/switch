# The Switch cloud machine image

A Switch cloud machine runs `switch-agent-controller`, the program any machine
runs agents with. The owner's managed agents placed on it run there, each as a
Linux user of its own, and they use the provider logins the owner gives the
machine.

## How a machine comes up

1. Core claims the machine for its owner.
2. The hosted controller creates the data volume and asks Core to prepare the
   machine. Until a controller enrolls for the machine, Core answers with a
   one-time **enrollment code**. The code is bound to the machine and is valid
   for 30 minutes. A retry of the same revision gets the same code.
3. The hosted controller launches the instance from this image with the bundle
   as its user data:

   ```json
   {"version": 4, "installationId": "…", "machineId": "…", "dataVolumeId": "vol-…",
    "apiEndpoint": "https://…",
    "controller": {"id": null, "enrollmentCode": "swce_…"}}
   ```

   Once the machine has a controller, `controller.id` names it and
   `enrollmentCode` is null. The bundle never holds a long-lived credential.
   The hosted controller gives a stopped instance the bundle of the machine's
   current revision before it starts it.
4. `switch-machine-boot.service` runs as root at every boot
   (`switch_machine_boot.py`):
   - It reads the bundle from the instance's user data (IMDSv2) on every boot,
     so a bundle replaced while the instance was stopped is the one used. An
     instance with no user data was not launched by the hosted controller: the
     boot stops there and is not retried.
   - It waits for the data volume, which is attached after the instance
     starts.
   - It formats the volume only if it is blank, then mounts it on `/data`
     (`nodev,nosuid`).
   - It checks the volume's marker (`/data/.switch-machine.json`), so the disk
     of one machine is never used by another.
   - With a code, it enrolls the controller as `switch-controller` into
     `/data/.switch-controller`. The credential and the sealing key are kept
     there, on the machine's own volume. The SHA-256 of the code is kept in
     `/data/.switch-controller-code`. A directory that still holds an
     enrollment made with another code is set aside first: Switch handed over
     a new code, so it holds no live controller for this machine. One made
     with this same code is kept: an earlier attempt of this boot enrolled,
     then failed before Switch linked the controller.
   - Then, on every boot, it runs `switch-agent-controller install-service
     --separate-users --no-block` with the agents' directories in
     `/data/agents`. That command is idempotent, and the root volume can be
     new after an image change. It queues the controller's start: the
     controller's unit is ordered after the boot service, so systemd starts it
     once the boot completes.
5. Core links the controller to the machine as a Switch cloud controller
   (kind `ec2`). The controller's status reports are the machine's heartbeat:
   the first one after the instance was seen running makes the machine
   `ready`.

If the owner removes the machine's controller in the Machines page, the next
start of the machine gets a new code, and the old controller is replaced. A
machine whose volume holds no enrollment and whose bundle has no code cannot
start, and its boot log says so. Removing its controller in the Machines page
gives it a new code.

## Baking the image

Put Node.js 24 at `/opt/switch/node`, and the provider CLIs under
`/opt/switch/<provider>/bin`. Agents cannot reach anything under a home
directory. Then, as root:

    install.sh <switch-agent-controller .tgz> <node-sha256> [agent-users]

`install.sh` does the following:

- Checks the commands the boot needs, and that polkit is present.
- Installs the controller at `/opt/switch/controller`.
- Creates the controller's user `switch-controller` (uid 2000), the agents'
  group `switch-agents-2000` (gid 2001) and one user per agent,
  `sa2000-01`… (uid 2101…).
- Installs the boot service, and orders the controller's service after it.
- Writes `/etc/switch-hosted/machine.json` with the controller user, Node.js, the CLI,
  the `PATH` the controller and its agents run with, and the number of agent
  users.

The ids are fixed because the data volume outlives the root volume. Every
instance of the image must give the files on it the same owners.

`agent-users` (16 by default) is how many agents a machine can run at once.

## Running it

- Core needs `AGENT_MANAGEMENT_ENABLED` as well as the hosted settings; see
  [../README.md](../README.md).
- The hosted controller's `image_id` must be an image baked here.
- A machine is stopped once its status reports say no session has
  run for `HOSTED_IDLE_STOP_MINUTES`. A message addressed to one of its agents,
  or placing an agent on it, starts it again; Switch keeps the message (up to
  15 minutes, in memory) until the controller is back and resumes from its
  saved cursor.

Tests: `uv run --with pytest python -m pytest tests` in this directory.
