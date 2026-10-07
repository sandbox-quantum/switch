# Controller runtime: local Linux gate

A local, disposable check of the cloud machine's controller runtime on a real
Linux userspace: Ubuntu 24.04 with systemd as PID 1, the real `install.sh`,
the real `switch-machine-boot`, the real `switch-controller` and real
`switch-agent@` units.

```bash
deploy/hosted/vm/gate/run.sh            # every assertion
deploy/hosted/vm/gate/run.sh 1 4        # only those assertions
KEEP=1 deploy/hosted/vm/gate/run.sh     # leave the container up to look around
```

Needs Docker (tested on Docker Desktop for macOS) and Node, which builds the runtime
bundles from this checkout (`deploy/hosted/build-runtime.mjs`). One full run
takes about 10–15 minutes. Every check prints `PASS` or `FAIL`. A known gap
that does not fail the gate prints `KNOWN`. The script exits non-zero if any
check failed. The full log is `/var/lib/cc-gate/checks.log` in the container.

Everything the gate creates is named `cc-gate-*`: the `cc-gate-machine`
container, the `cc-gate-net` network and the `cc-gate-image` image, plus a
`/tmp/cc-gate.*` work directory. All of it is removed on exit unless `KEEP=1`.
The gate makes **no AWS or GitHub calls**. KMS and Secrets Manager are moto.
Inside the container the real AWS endpoints and GitHub are pinned to
loopback, so a client that misses its override fails instead of leaving the
container.

## What is real and what is not

| Piece | In the gate |
| --- | --- |
| OS, systemd, polkit, units, `install.sh`, boot, controller, agent host | real (this checkout) |
| Switch Core | **a stub** (`container/stub_core.py`): only the routes a machine calls, in the wire shapes of Core's fixtures. No database, no Matrix, no rooms. Provider logins are sealed with Core's real `switch_core.providers.sealing`. |
| KMS, Secrets Manager | moto (`moto_server` on 127.0.0.1:5000) |
| Instance metadata | `container/fake_imds.py` (IMDSv2 tokens, instance id, placeholder role credentials) on 169.254.169.254 |
| EBS data volume | an ext4 loop device mounted on `/data`. `container/lsblk-wrapper` reports it as a `disk` whose serial is the assigned volume id. |
| Provider CLI | `container/fake_claude.py`: just enough of Claude's stream-json protocol for the Agent SDK. A `GATE_HOLD` message keeps a turn open until SIGUSR1, so a check can hold an agent busy. |
| Boot input | a v3 bundle given through `switch-machine-boot --bundle-file` (`SWITCH_MACHINE_BOOT_TEST_HOOKS=1`). The controller's KMS endpoint is pointed at moto through the controller config's `kms.endpoint` override. |

## Assertions

1. **The agent user is confined.** In its unit, and as plain `switch-agent`, an
   agent cannot list or read the controller's directories, its database, its
   credential or the provider files. It cannot see the controller's process,
   reach IMDS (root can), or `systemctl start` anything. It cannot read another
   agent's directories. Every agent runs as the one `switch-agent` uid, so
   `ProtectProc=invisible` does not separate two agents. Instead, each agent
   has its own PID namespace, and the gate checks the result. In agent 1's
   `/proc`, PID 1 is its init and its own agent host is listed. Agent 2,
   the controller and systemd are not listed. Agent 2's
   `/proc/<pid>/root` cannot be reached. The agent host runs as
   `switch-agent` with no capabilities.
2. **The controller may manage agent units only.** Over polkit it can start,
   restart and stop `switch-agent@<id>`. It cannot start `ssh`, an arbitrary
   unit, `switch-agent@../x` or `switch-agent@foo.bar`. It cannot kill, set
   properties on or mask a unit.
3. **A hostile symlink is not followed.** The shared agent directories are
   sticky. An agent cannot swap a controller-owned file for a link. Links that
   root plants, or that the agent plants in its own files (`health.json`) or
   directories (`watcher/supervisor/`), are refused, and a canary file stays
   untouched. `systemctl stop` leaves an agent unit `inactive`, with none of
   its processes left.
4. **Sealed login round trip.** A login sealed by the stub reaches the agent
   unit's `provider` credential and the provider's environment. A login sealed
   for another controller id, or relabelled to look like this one, is refused.
   A login revision change restarts an idle agent at once, and restarts a busy
   agent only after its turn ends.
5. **A per-user-v1 volume keeps its data.** A volume laid out the way the
   worker runtime left it (files, a bare mirror, one worktree branch with a
   commit per agent) survives the controller boot: every file and branch is
   intact, the controller layout marker is in place, and the agents and
   worktrees directories are the controller's.
6. **Relay parity.** A control message sent through Core reaches each agent's
   control server, and the reply comes back. An unreadable message comes back
   `refused_message`.
7. **An agent OOM does not take the controller down.** With a 160M limit on
   agent 2, the kernel OOM-kills it. The controller keeps its process, agent 1
   keeps running, systemd restarts agent 2, and the controller reports the OOM
   kill.

## Container quirks the gate works around

- **Mount propagation.** Docker mounts `/` private. systemd sets up each unit's
  `LoadCredential=` directory from a child namespace, so without
  `mount --make-rshared /` the units get an empty credentials directory.
- **cgroup delegation.** With `--cgroupns=host`, `docker exec` puts its
  processes in the container's root cgroup. cgroup v2 then refuses to enable
  controllers for its children, so `MemoryMax=` is not enforced. `setup.sh`
  moves those processes into `init.scope` and enables `+memory +pids` before
  it boots anything. Without this, assertion 7 cannot trigger an OOM.
- **Loop device.** The loop device stands in for EBS. It belongs to the Docker
  VM's kernel, so cleanup detaches it before removing the container.
- **`lsblk`.** The loop device has no serial, so `lsblk` is wrapped to report the
  assigned volume id for it alone.

## Not covered, and why

- **Real AWS.** There is no real EBS attach, IMDS, IAM role or instance profile.
  moto does not enforce KMS grant constraints or encryption-context conditions
  in IAM policy. The wrong-context checks prove that the controller passes the
  context and refuses a mismatch. They do not prove what AWS would deny.
- **Real Core.** The stub serves only the routes a machine calls. Core's own
  validation of status reports, assignments and operations is covered by
  Core's tests, not here.
- **GitHub.** The controller's repository refresh is not exercised. The
  fixture's mirror and worktrees are local.
- **Real providers.** There is no real Claude or Codex login and no model
  traffic. The fake CLI covers the session lifecycle and busy/idle only.
- **Scale and timing.** Two agents and short timeouts. There is no soak and no
  real network failure.
