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
resource "aws_iam_role" "machine" {
  name = "${local.prefix}-machine"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole"
  }] })
  tags = local.tags
}
resource "aws_iam_instance_profile" "machine" {
  name = aws_iam_role.machine.name
  role = aws_iam_role.machine.name
  tags = local.tags
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
resource "aws_iam_role_policy" "controller" {
  role = aws_iam_role.controller.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Sid = "Observe", Effect = "Allow", Action = ["ec2:DescribeInstances", "ec2:DescribeVolumes", "ec2:DescribeImages", "ec2:DescribeSubnets", "ec2:DescribeInstanceTypes"], Resource = "*" },
    { Sid = "ApprovedLaunchInputs", Effect = "Allow", Action = ["ec2:RunInstances"], Resource = [
      "arn:${data.aws_partition.current.partition}:ec2:${data.aws_region.current.name}::image/${var.worker_image_id}",
      "${local.ec2_arn_base}:subnet/${aws_subnet.worker.id}",
      "${local.ec2_arn_base}:security-group/${aws_security_group.worker.id}"
    ] },
    { Sid       = "CreateManagedLaunchResources", Effect = "Allow", Action = ["ec2:RunInstances"], Resource = ["${local.ec2_arn_base}:instance/*", "${local.ec2_arn_base}:network-interface/*"],
      Condition = { StringEquals = { "aws:RequestTag/switch:installation-id" = var.installation_id, "aws:RequestTag/switch:managed-by" = "switch-hosted-controller" }, Null = { "aws:RequestTag/switch:machine-id" = "false" } }
    },
    { Sid = "CreateManagedRoot", Effect = "Allow", Action = ["ec2:RunInstances"], Resource = "${local.ec2_arn_base}:volume/*",
      Condition = {
        StringEquals  = { "aws:RequestTag/switch:installation-id" = var.installation_id, "aws:RequestTag/switch:managed-by" = "switch-hosted-controller", "aws:RequestTag/switch:purpose" = "root", "ec2:VolumeType" = "gp3" }
        Null          = { "aws:RequestTag/switch:machine-id" = "false" }
        Bool          = { "ec2:Encrypted" = "true" }
        NumericEquals = { "ec2:VolumeSize" = var.root_volume_gib, "ec2:VolumeIops" = 3000, "ec2:VolumeThroughput" = 125 }
      }
    },
    { Sid = "CreateManagedData", Effect = "Allow", Action = ["ec2:CreateVolume"], Resource = "${local.ec2_arn_base}:volume/*",
      Condition = {
        StringEquals  = { "aws:RequestTag/switch:installation-id" = var.installation_id, "aws:RequestTag/switch:managed-by" = "switch-hosted-controller", "aws:RequestTag/switch:purpose" = "data", "ec2:VolumeType" = "gp3", "ec2:AvailabilityZone" = var.availability_zone }
        Null          = { "aws:RequestTag/switch:machine-id" = "false" }
        Bool          = { "ec2:Encrypted" = "true" }
        NumericEquals = { "ec2:VolumeSize" = var.data_volume_gib, "ec2:VolumeIops" = 3000, "ec2:VolumeThroughput" = 125 }
      }
    },
    { Sid       = "TagOnCreate", Effect = "Allow", Action = ["ec2:CreateTags"], Resource = ["${local.ec2_arn_base}:instance/*", "${local.ec2_arn_base}:volume/*", "${local.ec2_arn_base}:network-interface/*"],
      Condition = { StringEquals = { "ec2:CreateAction" = ["RunInstances", "CreateVolume"], "aws:RequestTag/switch:installation-id" = var.installation_id, "aws:RequestTag/switch:managed-by" = "switch-hosted-controller" }, Null = { "aws:RequestTag/switch:machine-id" = "false" } }
    },
    { Sid       = "ManageOwned", Effect = "Allow", Action = ["ec2:StartInstances", "ec2:StopInstances", "ec2:TerminateInstances", "ec2:AttachVolume", "ec2:DeleteVolume"], Resource = ["${local.ec2_arn_base}:instance/*", "${local.ec2_arn_base}:volume/*"],
      Condition = { StringEquals = { "ec2:ResourceTag/switch:installation-id" = var.installation_id, "ec2:ResourceTag/switch:managed-by" = "switch-hosted-controller", "ec2:ResourceTag/switch:purpose" = ["worker", "data"] }, Null = { "ec2:ResourceTag/switch:machine-id" = "false" } }
    },
    { Sid       = "PreserveAttachedData", Effect = "Allow", Action = ["ec2:ModifyInstanceAttribute"], Resource = "${local.ec2_arn_base}:instance/*",
      Condition = { StringEquals = { "ec2:ResourceTag/switch:installation-id" = var.installation_id, "ec2:ResourceTag/switch:managed-by" = "switch-hosted-controller", "ec2:ResourceTag/switch:purpose" = ["worker", "data"], "ec2:Attribute" = "blockDeviceMapping" }, Null = { "ec2:ResourceTag/switch:machine-id" = "false" } }
    },
    { Sid = "PassOnlyMachineRole", Effect = "Allow", Action = ["iam:PassRole"], Resource = aws_iam_role.machine.arn, Condition = { StringEquals = { "iam:PassedToService" = "ec2.amazonaws.com" } } },
    { Sid = "DenyUnapprovedType", Effect = "Deny", Action = ["ec2:RunInstances"], Resource = "${local.ec2_arn_base}:instance/*", Condition = { StringNotEquals = { "ec2:InstanceType" = var.allowed_instance_types } } },
    { Sid = "RequireMetadataTokens", Effect = "Deny", Action = ["ec2:RunInstances"], Resource = "${local.ec2_arn_base}:instance/*", Condition = { StringNotEquals = { "ec2:MetadataHttpTokens" = "required" } } }
  ] })
}
