# Backing up Switch

This chart **does not ship backup jobs**, by design. A backup that writes to a
PersistentVolume on the same cluster shares the storage backend it is meant to
protect, and every serious Kubernetes environment already has stronger, portable
primitives: CSI **VolumeSnapshots**, managed-database backups, and cluster-wide
tools like **Velero**. Use those. This doc says what to back up and how.

## What to back up (and why)

| Data | Where | Why it matters |
|------|-------|----------------|
| **Tuwunel volume** | PVC `<release>-tuwunel-data` | Holds the Matrix **signing key** — your homeserver's cryptographic identity. Lose it and every `@user:server` account is orphaned and the homeserver can never be restored or federate as itself again. **This is the single most important thing to back up.** |
| **Postgres** | PVC `<release>-postgresql-data` (managed mode) or your external DB | All Switch application state + the Mattermost database. |
| Mattermost files | PVC `<release>-mattermost-data` | Uploaded files/attachments (if you use the Mattermost bridge). |

`<release>` is your Helm release name (`kubectl get pvc` to see the real names).

Tuwunel runs an embedded RocksDB on a ReadWriteOnce volume; treat it as a
database, not just files.

## Option 1 — CSI VolumeSnapshots (recommended)

If your cluster has a CSI driver with snapshot support (EKS/GKE/AKS and most
managed clusters do) and the external-snapshotter installed, snapshot the PVCs
directly. This is point-in-time and consistent, and does not fight the
ReadWriteOnce mount. See `samples/volumesnapshot.example.yaml`.

For the strongest Tuwunel consistency, scale it down first so RocksDB flushes:

```sh
kubectl scale deploy/<release>-tuwunel --replicas=0
# take the VolumeSnapshot of <release>-tuwunel-data
kubectl scale deploy/<release>-tuwunel --replicas=1
```

Automate snapshots on a schedule with a tool like
[snapscheduler](https://backube.github.io/snapscheduler/) or Velero.

## Option 2 — Postgres logical dumps

Portable and cluster-independent. Run against the DB (bundled or external):

```sh
kubectl exec -it <release>-postgresql-0 -- \
  pg_dumpall -U postgres | gzip > switch-$(date +%F).sql.gz
```

Managed Postgres (RDS / Cloud SQL / Azure): prefer the provider's automated
backups / PITR.

## Option 3 — Velero (cluster-wide)

[Velero](https://velero.io/) backs up Kubernetes resources **and** PVs (via CSI
snapshots or restic/kopia file backup) to object storage, and restores them —
the most complete DR story. Back up this release's namespace on a schedule.

## Restore sketch

1. Restore/attach the PVs (from VolumeSnapshot or Velero) **before** installing,
   or install with persistence pointing at the restored volumes.
2. For a Postgres logical dump: `gunzip -c dump.sql.gz | psql -U postgres`.
3. Keep `tuwunel.serverName` **identical** to the original — the signing key is
   bound to it; changing it orphans all accounts even with the data restored.
