# IAM for `switch-hosted-migration-cloud`

`switch-hosted-migration-cloud` (`controller/src/switch_hosted_controller/migration_cloud.py`)
runs on an operator's machine, from Core's record of one person's move
(`switch-hosted-migration record PERSON`). It needs EC2 rights for two steps
only:

- `snapshot`: snapshot the v1 machine's data disk once the move is frozen.
- `clean-up --execute`: once Core records the move `cleaned`, terminate the v1
  instance, delete its data disk and delete the migration snapshot.

The role below is scoped by tag, so it can't act on anything the v1 hosted
controller or this tool didn't tag. The tool checks the same tags itself before
every call, and refuses a resource with any tag missing or wrong. IAM is the
second line, so a bug in the tool still can't reach another environment's or
another person's resources beyond the tags.

The tags the role relies on:

| Resource | Tags (all required) |
|---|---|
| v1 data disk | `switch:installation-id`, `switch:machine-id`, `switch:purpose=data`, `switch:managed-by=switch-hosted-controller` |
| v1 instance | the same, with `switch:purpose=worker` |
| migration snapshot (made by this tool) | `switch:installation-id`, `switch:machine-id`, `switch:owner-keyed-id`, `switch:source-volume-id`, `switch:purpose=migration-copy`, `switch:managed-by=switch-hosted-migration` |

`switch:owner-keyed-id` is the person's keyed id from Core, never their user id
or name.

## Policy

Replace `REGION`, `ACCOUNT` and `INSTALLATION` with the environment's own
values, one role per environment. Nothing here is account-wide except the
read-only `Describe*` calls, which EC2 can't scope by resource.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Read",
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeVolumes",
        "ec2:DescribeInstances",
        "ec2:DescribeSnapshots",
        "ec2:DescribeSnapshotAttribute"
      ],
      "Resource": "*"
    },
    {
      "Sid": "SnapshotOnlyAV1DataDiskOfThisInstallation",
      "Effect": "Allow",
      "Action": "ec2:CreateSnapshot",
      "Resource": "arn:aws:ec2:REGION:ACCOUNT:volume/*",
      "Condition": {
        "StringEquals": {
          "aws:ResourceTag/switch:installation-id": "INSTALLATION",
          "aws:ResourceTag/switch:purpose": "data",
          "aws:ResourceTag/switch:managed-by": "switch-hosted-controller"
        }
      }
    },
    {
      "Sid": "TheSnapshotMustBeTaggedAsAMigrationCopyWhenMade",
      "Effect": "Allow",
      "Action": "ec2:CreateSnapshot",
      "Resource": "arn:aws:ec2:REGION::snapshot/*",
      "Condition": {
        "StringEquals": {
          "aws:RequestTag/switch:installation-id": "INSTALLATION",
          "aws:RequestTag/switch:purpose": "migration-copy",
          "aws:RequestTag/switch:managed-by": "switch-hosted-migration"
        },
        "Null": {
          "aws:RequestTag/switch:machine-id": "false",
          "aws:RequestTag/switch:owner-keyed-id": "false",
          "aws:RequestTag/switch:source-volume-id": "false"
        }
      }
    },
    {
      "Sid": "TagOnlyWhileCreatingTheSnapshot",
      "Effect": "Allow",
      "Action": "ec2:CreateTags",
      "Resource": "arn:aws:ec2:REGION::snapshot/*",
      "Condition": {"StringEquals": {"ec2:CreateAction": "CreateSnapshot"}}
    },
    {
      "Sid": "TerminateOnlyAV1InstanceOfThisInstallation",
      "Effect": "Allow",
      "Action": "ec2:TerminateInstances",
      "Resource": "arn:aws:ec2:REGION:ACCOUNT:instance/*",
      "Condition": {
        "StringEquals": {
          "aws:ResourceTag/switch:installation-id": "INSTALLATION",
          "aws:ResourceTag/switch:purpose": "worker",
          "aws:ResourceTag/switch:managed-by": "switch-hosted-controller"
        }
      }
    },
    {
      "Sid": "DeleteOnlyAV1DataDiskOfThisInstallation",
      "Effect": "Allow",
      "Action": "ec2:DeleteVolume",
      "Resource": "arn:aws:ec2:REGION:ACCOUNT:volume/*",
      "Condition": {
        "StringEquals": {
          "aws:ResourceTag/switch:installation-id": "INSTALLATION",
          "aws:ResourceTag/switch:purpose": "data",
          "aws:ResourceTag/switch:managed-by": "switch-hosted-controller"
        }
      }
    },
    {
      "Sid": "DeleteOnlyAMigrationSnapshotOfThisInstallation",
      "Effect": "Allow",
      "Action": "ec2:DeleteSnapshot",
      "Resource": "arn:aws:ec2:REGION::snapshot/*",
      "Condition": {
        "StringEquals": {
          "aws:ResourceTag/switch:installation-id": "INSTALLATION",
          "aws:ResourceTag/switch:purpose": "migration-copy",
          "aws:ResourceTag/switch:managed-by": "switch-hosted-migration"
        }
      }
    },
    {
      "Sid": "NeverShareRetagOrCopy",
      "Effect": "Deny",
      "Action": [
        "ec2:ModifySnapshotAttribute",
        "ec2:CopySnapshot",
        "ec2:DeleteTags",
        "ec2:CreateVolume",
        "ec2:AttachVolume",
        "ec2:StartInstances",
        "ec2:ModifyInstanceAttribute"
      ],
      "Resource": "*"
    }
  ]
}
```

What each part rules out:

- **No sharing.** `ModifySnapshotAttribute` is denied, so the snapshot can't be
  made public or given to another account. `snapshot` also reads the
  snapshot's sharing back and refuses if any is set.
- **No re-tagging.** `CreateTags` works only while a snapshot is being made,
  and `DeleteTags` is denied, so nobody can tag another disk into scope with
  this role.
- **No volumes or starts.** Restoring the snapshot as a volume for the copy is
  the copy runner's job, through the EBS CSI driver's own role
  (`migration-copy-design`). This role can't create, attach or start anything.
- **One environment.** Every condition pins `switch:installation-id`, and the
  tool requires the same value as `--installation-id`.

## For platform to confirm

- **KMS.** v1 disks use the AWS-managed EBS key in the same account, so a
  snapshot of one is encrypted with that key and needs no grant from this role.
  If any environment used a customer-managed key, the role also needs
  `kms:CreateGrant`, `kms:DescribeKey` and `kms:GenerateDataKeyWithoutPlaintext`
  on that key only, with `kms:ViaService` set to EC2 in the region.
- **Who assumes it.** The operator's own SSO role, through a session tagged
  with their identity, so CloudTrail names who ran each step. The tool records
  nothing itself beyond printing resource ids.
- **The root disk.** A v1 instance's root disk is deleted with the instance by
  EC2 (`DeleteOnTermination`). If one stays, `clean-up` reports it and exits 3.
  It never deletes an untagged disk, and this role couldn't either.
