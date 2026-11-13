# Shared-cluster box settings

Settings for the shared cluster that runs users' boxes, kept with the code so they're
reviewed and versioned like it. The box template itself moves here too.

## The shared services, one per zone

Name lookup (`coredns`) and the disk controller (`ebs-csi-controller`) are EKS add-ons. Each
runs two copies on the system machines, one machine per zone. If both copies sit in one zone,
an outage of that zone stops the service for every box, so they're kept apart by rule:

- `addon-values/coredns.json` and `addon-values/aws-ebs-csi-driver.json` are each add-on's
  `configuration_values`. They set:
  - two copies, only on system machines, tolerating only the system taint;
  - never two copies on one machine (required pod anti-affinity by hostname);
  - spread across zones (`maxSkew 1`, `ScheduleAnyway`, so a zone outage never stops a copy
    starting in the zone that's up);
  - at most one copy down at a time (the add-on's PodDisruptionBudget).

  Checked against each add-on's own schema at the versions in use (`coredns
  v1.14.7-eksbuild.11`, `aws-ebs-csi-driver v1.67.1-eksbuild.1`; the schemas are in
  `controller/tests/fixtures/addon-schemas/`). Re-check them when either add-on is upgraded.
- With one system machine per zone, the anti-affinity is enough on its own: when a zone is
  down, its copy waits Pending, and it starts there again when the zone returns. Nothing moves
  a running copy, so a second system machine in a zone would need something more (a check
  that warns when both copies share a zone).

## One priority for every box

`priorityclass-switch-box.yaml`: `switch-box`, the same value for every box, below the shared
services, and never preempting. A box waiting for room never pushes another box off a
machine, and under memory pressure boxes are ranked by how far each is over its own request,
never by whose box it is. The box template sets `priorityClassName: switch-box`. A
namespace's ResourceQuota must allow the `switch-box` class.

## Applying

Nothing here is applied by the repo. On a cluster, applying it is a reviewed change: the
add-on values go in through the cluster's Terraform, and the priority class is applied with
the quota change that allows it, one at a time.
