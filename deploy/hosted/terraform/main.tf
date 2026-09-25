data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

locals {
  prefix       = "switch-hosted-${substr(var.installation_id, 0, 16)}-${substr(sha256(var.installation_id), 0, 8)}"
  issuer       = trimprefix(var.oidc_issuer_url, "https://")
  ec2_arn_base = "arn:${data.aws_partition.current.partition}:ec2:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}"
  tags         = { "switch:installation-id" = var.installation_id }
}

resource "aws_security_group" "worker" {
  name_prefix = "${local.prefix}-"
  description = "Isolated hosted workers: no inbound access; HTTP(S) egress"
  vpc_id      = aws_vpc.worker.id
  tags        = local.tags
}
resource "aws_vpc_security_group_egress_rule" "worker" {
  for_each          = toset(["80", "443"])
  security_group_id = aws_security_group.worker.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
  ip_protocol       = "tcp"
}
resource "aws_iam_role" "worker" {
  for_each = var.assignments
  name     = "${local.prefix}-${substr(each.key, 0, 12)}-${substr(sha256(each.key), 0, 8)}"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole"
  }] })
  tags = merge(local.tags, { "switch:agent-id" = each.key })
}
resource "aws_iam_role_policy" "worker_secret" {
  for_each = var.assignments
  role     = aws_iam_role.worker[each.key].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = each.value.secret_arn, Condition = { StringEquals = { "secretsmanager:VersionStage" = "AWSCURRENT" } } },
    { Effect = "Allow", Action = ["kms:Decrypt"], Resource = each.value.kms_key_arn,
      Condition = { StringEquals = {
        "kms:ViaService"                  = "secretsmanager.${data.aws_region.current.name}.${data.aws_partition.current.dns_suffix}"
        "kms:EncryptionContext:SecretARN" = each.value.secret_arn
      } }
    }
  ] })
}
resource "aws_iam_instance_profile" "worker" {
  for_each = var.assignments
  name     = aws_iam_role.worker[each.key].name
  role     = aws_iam_role.worker[each.key].name
  tags     = merge(local.tags, { "switch:agent-id" = each.key })
}
resource "aws_iam_role" "controller" {
  name = "${local.prefix}-controller"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Federated = var.oidc_provider_arn }, Action = "sts:AssumeRoleWithWebIdentity",
    Condition = { StringEquals = {
      "${local.issuer}:sub" = "system:serviceaccount:${var.namespace}:${var.service_account}"
      "${local.issuer}:aud" = "sts.amazonaws.com"
    } }
  }] })
  tags = local.tags
}
resource "aws_iam_policy" "controller_assignments" {
  lifecycle {
    postcondition {
      condition     = length(self.policy) <= 6144
      error_message = "Assignment permissions exceed the managed IAM policy limit; reduce the assignment pool."
    }
  }
  name = "${local.prefix}-assignments"
  tags = local.tags
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Sid = "PopulateWorkerAssignments", Effect = "Allow", Action = ["secretsmanager:DescribeSecret", "secretsmanager:PutSecretValue"], Resource = [for assignment in values(var.assignments) : assignment.secret_arn] },
    { Sid = "EncryptWorkerAssignments", Effect = "Allow", Action = ["kms:GenerateDataKey", "kms:Decrypt"], Resource = distinct([for assignment in values(var.assignments) : assignment.kms_key_arn]),
      Condition = { StringEquals = {
        "kms:ViaService"                  = "secretsmanager.${data.aws_region.current.name}.${data.aws_partition.current.dns_suffix}"
        "kms:EncryptionContext:SecretARN" = [for assignment in values(var.assignments) : assignment.secret_arn]
      } }
    }
  ] })
}
resource "aws_iam_role_policy_attachment" "controller_assignments" {
  role       = aws_iam_role.controller.name
  policy_arn = aws_iam_policy.controller_assignments.arn
}
resource "aws_iam_role_policy" "controller" {
  depends_on = [aws_iam_role_policy_attachment.controller_assignments]
  lifecycle {
    postcondition {
      condition     = length(self.policy) <= 10240
      error_message = "Controller permissions exceed the inline IAM policy limit; reduce the assignment pool."
    }
  }
  role = aws_iam_role.controller.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Sid = "Observe", Effect = "Allow", Action = ["ec2:DescribeInstances", "ec2:DescribeVolumes", "ec2:DescribeImages", "ec2:DescribeSubnets", "ec2:DescribeInstanceTypes"], Resource = "*" },
    { Sid = "ApprovedLaunchInputs", Effect = "Allow", Action = ["ec2:RunInstances"], Resource = [
      "arn:${data.aws_partition.current.partition}:ec2:${data.aws_region.current.name}::image/${var.worker_image_id}",
      "${local.ec2_arn_base}:subnet/${aws_subnet.worker.id}",
      "${local.ec2_arn_base}:security-group/${aws_security_group.worker.id}"
    ] },
    { Sid       = "CreateVerificationInstances", Effect = "Allow", Action = ["ec2:RunInstances"], Resource = ["${local.ec2_arn_base}:instance/*", "${local.ec2_arn_base}:network-interface/*"],
      Condition = { StringEquals = { "aws:RequestTag/switch:installation-id" = var.installation_id, "aws:RequestTag/switch:managed-by" = "switch-provider-verification" } }
    },
    { Sid = "CreateVerificationRoot", Effect = "Allow", Action = ["ec2:RunInstances"], Resource = "${local.ec2_arn_base}:volume/*",
      Condition = {
        StringEquals  = { "aws:RequestTag/switch:installation-id" = var.installation_id, "aws:RequestTag/switch:managed-by" = "switch-provider-verification", "ec2:VolumeType" = "gp3" }
        Bool          = { "ec2:Encrypted" = "true" }
        NumericEquals = { "ec2:VolumeSize" = var.root_volume_gib }
      }
    },
    { Sid       = "TagVerificationResources", Effect = "Allow", Action = ["ec2:CreateTags"], Resource = ["${local.ec2_arn_base}:instance/*", "${local.ec2_arn_base}:volume/*", "${local.ec2_arn_base}:network-interface/*"],
      Condition = { StringEquals = { "ec2:CreateAction" = "RunInstances", "aws:RequestTag/switch:installation-id" = var.installation_id, "aws:RequestTag/switch:managed-by" = "switch-provider-verification" } }
    },
    { Sid       = "TerminateVerificationInstances", Effect = "Allow", Action = ["ec2:TerminateInstances"], Resource = "${local.ec2_arn_base}:instance/*",
      Condition = { StringEquals = { "ec2:ResourceTag/switch:installation-id" = var.installation_id, "ec2:ResourceTag/switch:managed-by" = "switch-provider-verification" } }
    },
    { Sid       = "CreateManagedLaunchResources", Effect = "Allow", Action = ["ec2:RunInstances"], Resource = ["${local.ec2_arn_base}:instance/*", "${local.ec2_arn_base}:network-interface/*"],
      Condition = { StringEquals = { "aws:RequestTag/switch:installation-id" = var.installation_id, "aws:RequestTag/switch:managed-by" = "switch-hosted-controller", "aws:RequestTag/switch:generation" = "1" }, StringLike = { "aws:RequestTag/switch:agent-id" = keys(var.assignments) } }
    },
    { Sid = "CreateManagedRoot", Effect = "Allow", Action = ["ec2:RunInstances"], Resource = "${local.ec2_arn_base}:volume/*",
      Condition = {
        StringEquals  = { "aws:RequestTag/switch:installation-id" = var.installation_id, "aws:RequestTag/switch:managed-by" = "switch-hosted-controller", "aws:RequestTag/switch:generation" = "1", "aws:RequestTag/switch:purpose" = "root", "ec2:VolumeType" = "gp3" }
        StringLike    = { "aws:RequestTag/switch:agent-id" = keys(var.assignments) }
        Bool          = { "ec2:Encrypted" = "true" }
        NumericEquals = { "ec2:VolumeSize" = var.root_volume_gib, "ec2:VolumeIops" = 3000, "ec2:VolumeThroughput" = 125 }
      }
    },
    { Sid = "CreateManagedData", Effect = "Allow", Action = ["ec2:CreateVolume"], Resource = "${local.ec2_arn_base}:volume/*",
      Condition = {
        StringEquals  = { "aws:RequestTag/switch:installation-id" = var.installation_id, "aws:RequestTag/switch:managed-by" = "switch-hosted-controller", "aws:RequestTag/switch:generation" = "1", "aws:RequestTag/switch:purpose" = "data", "ec2:VolumeType" = "gp3", "ec2:AvailabilityZone" = var.availability_zone }
        StringLike    = { "aws:RequestTag/switch:agent-id" = keys(var.assignments) }
        Bool          = { "ec2:Encrypted" = "true" }
        NumericEquals = { "ec2:VolumeSize" = var.data_volume_gib, "ec2:VolumeIops" = 3000, "ec2:VolumeThroughput" = 125 }
      }
    },
    { Sid       = "TagOnCreate", Effect = "Allow", Action = ["ec2:CreateTags"], Resource = ["${local.ec2_arn_base}:instance/*", "${local.ec2_arn_base}:volume/*", "${local.ec2_arn_base}:network-interface/*"],
      Condition = { StringEquals = { "ec2:CreateAction" = ["RunInstances", "CreateVolume"], "aws:RequestTag/switch:installation-id" = var.installation_id, "aws:RequestTag/switch:managed-by" = "switch-hosted-controller", "aws:RequestTag/switch:generation" = "1" }, StringLike = { "aws:RequestTag/switch:agent-id" = keys(var.assignments) } }
    },
    { Sid       = "ManageOwned", Effect = "Allow", Action = ["ec2:StartInstances", "ec2:StopInstances", "ec2:TerminateInstances", "ec2:AttachVolume", "ec2:DeleteVolume"], Resource = ["${local.ec2_arn_base}:instance/*", "${local.ec2_arn_base}:volume/*"],
      Condition = { StringEquals = { "ec2:ResourceTag/switch:installation-id" = var.installation_id, "ec2:ResourceTag/switch:managed-by" = "switch-hosted-controller", "ec2:ResourceTag/switch:generation" = "1", "ec2:ResourceTag/switch:purpose" = ["worker", "data"] }, StringLike = { "ec2:ResourceTag/switch:agent-id" = keys(var.assignments) } }
    },
    { Sid       = "PreserveAttachedData", Effect = "Allow", Action = ["ec2:ModifyInstanceAttribute"], Resource = "${local.ec2_arn_base}:instance/*",
      Condition = { StringEquals = { "ec2:ResourceTag/switch:installation-id" = var.installation_id, "ec2:ResourceTag/switch:managed-by" = "switch-hosted-controller", "ec2:ResourceTag/switch:generation" = "1", "ec2:ResourceTag/switch:purpose" = ["worker", "data"], "ec2:Attribute" = "blockDeviceMapping" }, StringLike = { "ec2:ResourceTag/switch:agent-id" = keys(var.assignments) } }
    },
    { Sid = "PassOnlyWorkerRoles", Effect = "Allow", Action = ["iam:PassRole"], Resource = [for role in aws_iam_role.worker : role.arn], Condition = { StringEquals = { "iam:PassedToService" = "ec2.amazonaws.com" } } },
    { Sid = "DenyUnapprovedType", Effect = "Deny", Action = ["ec2:RunInstances"], Resource = "${local.ec2_arn_base}:instance/*", Condition = { StringNotEquals = { "ec2:InstanceType" = var.allowed_instance_types } } },
    { Sid = "RequireMetadataTokens", Effect = "Deny", Action = ["ec2:RunInstances"], Resource = "${local.ec2_arn_base}:instance/*", Condition = { StringNotEquals = { "ec2:MetadataHttpTokens" = "required" } } }
  ] })
}
