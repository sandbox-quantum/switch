# The Switch cloud machine image

A Switch cloud machine runs `switch-agent-controller`, the program any machine
runs agents with: one controller per workspace that uses the machine, up to 8.
Each workspace's managed agents placed on it run under that workspace's
controller, each as a Linux user of its own, and they use the provider logins
the workspace gives the machine.

## How a machine comes up

1. Core claims the machine for its owner.
2. The hosted controller creates the data volume and asks Core to prepare the
   machine. Core lists one **seat** per workspace on the machine, the oldest
   workspace first. Until a controller enrolls for a seat, Core answers with a
   one-time **enrollment code** for it. The code is bound to the machine and
   is valid for 30 minutes. A retry of the same revision gets the same code.
3. The hosted controller launches the instance from this image with the bundle
   as its user data:

   ```json
   {"version": 5, "installationId": "…", "machineId": "…", "dataVolumeId": "vol-…",
    "apiEndpoint": "https://…",
    "controllers": [
      {"key": "<uuid>", "id": "<uuid>", "enrollmentCode": null},
      {"key": "<uuid>", "id": null, "enrollmentCode": "swce_…"}]}
   ```

   `controllers` lists 1 to 8 seats, each with a `key` of its own (a UUID
   naming the workspace's seat on this machine; the boot only uses it to tell
   seats apart). Once a seat has a controller, its `id` names it and its
   `enrollmentCode` is null; before, its `id` is null and it has a code. The
   image reads version 5 only, strictly: a bundle with any other version, an
   unknown key, a repeated seat key, no seat or more than 8 is refused. The
   bundle never holds a long-lived credential.
   An instance boots from the bundle it was launched with. When the machine
   needs a new enrollment code, a new endpoint or another set of seats, the
   hosted controller terminates the stopped instance and launches a new one
   with the new bundle, on the same data volume. A bundle that only names the
   controller a seat enrolled as is not one of those: the boot keeps an
   enrollment made with the code it already has.
4. `switch-machine-boot.service` runs as root at every boot
   (`switch_machine_boot.py`):
   - It reads the bundle from the instance's user data (IMDSv2) on every boot.
     An instance with no user data was not launched by the hosted controller:
     the boot stops there and is not retried.
   - It waits for the data volume, which is attached after the instance
     starts.
   - It formats the volume only if it is blank, then mounts it on `/data`
     (`nodev,nosuid`).
   - It checks the volume's marker (`/data/.switch-machine.json`), so the disk
     of one machine is never used by another.
   - It gives each seat an **index** (see below), kept on the volume.
   - For each seat with a code, it enrolls the seat's controller as the seat's
     controller user into its data directory. The credential and the sealing
     key are kept there, on the machine's own volume. The SHA-256 of the code
     is kept in the seat's code file. A directory that still holds an
     enrollment made with another code is set aside first, next to it, as
     `<data directory>.replaced-<time>`: Switch handed over a new code, so it
     holds no live controller for this seat. One made with this same code is
     kept: an earlier attempt of this boot enrolled, then failed before Switch
     linked the controller.
   - Then, on every boot, it runs `switch-agent-controller install-service
     --separate-users --no-block` for each seat, with the seat's agents'
     directory. That command is idempotent, and the root volume can be new
     after an image change. It queues the controller's start: each
     controller's unit is ordered after the boot service, so systemd starts it
     once the boot completes.
   - A controller that fails to enroll or start does not keep the others from
     starting. The boot tries it again 4 times, 30 s apart, then logs the
     failure and completes anyway: failing the boot would stop the other
     controllers, which are ordered after it. That workspace then shows the
     machine in error in Switch Console, and a stop and start of the machine
     tries again.
5. Core links each controller to the machine as a Switch cloud controller
   (kind `ec2`). The controllers' status reports are the machine's heartbeat:
   the first one after the instance was seen running makes the machine
   `ready`.

If a workspace removes the machine's controller in its Machines page, the next
start of the machine gets a new code for that seat, and the old controller is
replaced. A seat whose data directory holds no enrollment and whose bundle
entry has no code cannot start, and the boot log says so. Removing its
controller in the Machines page gives it a new code.

## Controllers on a machine

The first time the boot sees the volume, it numbers the bundle's seats 0, 1, …
in bundle order. Core lists the oldest workspace first, so a volume that
predates several controllers per machine keeps its enrollment at index 0. A
seat added later gets the lowest index no other seat holds. The indexes are
kept in `/data/.switch-controllers.json`
(`{"version": 1, "controllers": {"<key>": <index>}}`, mode 0600), and an index
is never given to another seat while its seat is in that file, which keeps
seats that left. Since nothing is ever removed from it, a volume can have
held at most 8 different seats; a new seat past that cannot start, and the
boot log says so.

Index `k`'s ids are fixed, because the data volume outlives the root volume:

| | index 0 | index k ≥ 1 |
|---|---|---|
| controller user and its group (uid = gid) | `switch-controller`, 2000 | `switch-controller-<k>`, 2000 + 200·k |
| agents' group | `switch-agents-2000`, 2001 | `switch-agents-<uid>`, uid + 1 |
| agent users (NN = 01…agent users) | `sa2000-NN`, 2100 + NN | `sa<uid>-NN`, uid + 100 + NN |
| controller unit | `switch-agent-controller-2000.service` | `switch-agent-controller-<uid>.service` |
| data directory | `/data/.switch-controller` | `/data/controllers/<k>/data` |
| code file | `/data/.switch-controller-code` | `/data/controllers/<k>/code` |
| agents' directories | `/data/agents` | `/data/controllers/<k>/agents` |

The image bakes index 0's users (`install.sh`). For an index k ≥ 1, the boot
creates the users and groups that are missing with these ids, as `install.sh`
does, before `install-service`, which then creates none; a user or group that
exists with another id is refused. It also writes the drop-in that orders the
seat's controller unit after the boot service
(`/etc/systemd/system/switch-agent-controller-<uid>.service.d/after-boot.conf`)
on every boot, since the root volume can be new.

A seat that is in `/data/.switch-controllers.json` but not in the bundle (its
workspace left the machine) has its controller stopped and disabled, and any
of its agents still running stopped. Its data stays on the volume and its
index stays reserved; the boot logs a warning. If the workspace comes back
with the same seat key, its controller starts again from that data.

## Baking the image

Put Node.js 24 at `/opt/switch/node`, and the provider CLIs under
`/opt/switch/<provider>/bin`. Agents cannot reach anything under a home
directory. Then, as root:

    install.sh <switch-agent-controller .tgz> <node-sha256> [agent-users]

`install.sh` does the following:

- Checks the commands the boot needs, and that polkit is present.
- Installs the controller at `/opt/switch/controller`.
- Creates index 0's controller user `switch-controller` (uid 2000), the
  agents' group `switch-agents-2000` (gid 2001) and one user per agent,
  `sa2000-01`… (uid 2101…). The boot creates the other indexes' users.
- Installs the boot service, and orders index 0's controller service after it.
- Writes `/etc/switch-hosted/machine.json` with the controller user, Node.js, the CLI,
  the `PATH` the controller and its agents run with, and the number of agent
  users.

The ids are fixed because the data volume outlives the root volume. Every
instance of the image must give the files on it the same owners.

`agent-users` (16 by default) is how many agents each controller on a machine
can run at once.

## Running it

- Core needs the `hosted_agents` and `agent_management` feature flags as
  well as the hosted settings; see
  [../README.md](../README.md).
- The hosted controller's `image_id` must be an image baked here.
- A machine is stopped once its status reports say no session has
  run for `HOSTED_IDLE_STOP_MINUTES`. A message addressed to one of its agents,
  or placing an agent on it, starts it again; Switch keeps the message (up to
  15 minutes, in memory) until the controller is back and resumes from its
  saved cursor.

Tests: `uv run --with pytest python -m pytest tests` in this directory.
