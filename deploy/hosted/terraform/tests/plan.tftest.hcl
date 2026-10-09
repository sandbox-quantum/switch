mock_provider "aws" {
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::000000000000:role/example-machine" }
  }
  mock_resource "aws_iam_instance_profile" {
    defaults = { arn = "arn:aws:iam::000000000000:instance-profile/example-machine" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "000000000000" }
  }
  mock_data "aws_region" {
    defaults = { name = "us-east-1" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws", dns_suffix = "amazonaws.com" }
  }
}

variables {
  installation_id     = "example-hosted"
  availability_zone   = "us-east-1a"
  worker_vpc_cidr     = "10.80.0.0/16"
  public_subnet_cidr  = "10.80.0.0/24"
  private_subnet_cidr = "10.80.1.0/24"
  worker_image_id     = "ami-00000000000000000"
  oidc_provider_arn   = "arn:aws:iam::000000000000:oidc-provider/example.invalid"
  oidc_issuer_url     = "https://example.invalid"
  namespace           = "example-hosted"
  service_account     = "switch-hosted-controller"
}

run "isolated_plan" {
  command = plan
  assert {
    condition     = aws_subnet.worker.map_public_ip_on_launch == false
    error_message = "Worker subnet must not assign public IPs."
  }
  assert {
    condition     = jsondecode(aws_iam_role.machine.assume_role_policy).Statement[0].Principal.Service == "ec2.amazonaws.com"
    error_message = "The machine role must be assumable by EC2 only."
  }
  assert {
    condition     = alltrue([for rule in aws_network_acl_rule.deny_private_egress : rule.rule_action == "deny" && rule.rule_number < 100])
    error_message = "Private-destination deny rules must precede Internet allow rules."
  }
}

run "rendered_permissions" {
  command = apply
  assert {
    condition = alltrue([for statement in jsondecode(aws_iam_role_policy.controller.policy).Statement :
      statement.Condition.Null[startswith(statement.Sid, "CreateManaged") || statement.Sid == "TagOnCreate" ? "aws:RequestTag/switch:machine-id" : "ec2:ResourceTag/switch:machine-id"] == "false"
      if contains(["CreateManagedLaunchResources", "CreateManagedRoot", "CreateManagedData", "TagOnCreate", "ManageOwned", "SetDataRetentionAndUserData"], statement.Sid)
    ]) && length([for statement in jsondecode(aws_iam_role_policy.controller.policy).Statement : statement if contains(["CreateManagedLaunchResources", "CreateManagedRoot", "CreateManagedData", "TagOnCreate", "ManageOwned", "SetDataRetentionAndUserData"], statement.Sid)]) == 6
    error_message = "Managed resources must carry a machine id tag."
  }
  assert {
    condition     = one([for statement in jsondecode(aws_iam_role_policy.controller.policy).Statement : statement if statement.Sid == "PassOnlyMachineRole"]).Resource == aws_iam_role.machine.arn
    error_message = "The controller may pass only the machine role."
  }
  assert {
    condition     = output.machine_instance_profile_arn == aws_iam_instance_profile.machine.arn
    error_message = "The machine instance profile must be an output for the controller configuration."
  }
  assert {
    condition     = !strcontains(aws_iam_role_policy.controller.policy, "secretsmanager") && !strcontains(aws_iam_role_policy.controller.policy, "kms:")
    error_message = "The controller needs no secrets: a machine's bundle is its user data."
  }
  assert {
    condition     = var.data_volume_gib == 200 && one([for statement in jsondecode(aws_iam_role_policy.controller.policy).Statement : statement if statement.Sid == "DenyUnapprovedType"]).Condition.StringNotEquals["ec2:InstanceType"] == ["c7i.2xlarge"]
    error_message = "Defaults must allow c7i.2xlarge workers with 200 GiB data disks."
  }
  assert {
    condition = alltrue([for statement in jsondecode(aws_iam_role_policy.controller.policy).Statement :
      statement.Condition.StringEquals["ec2:ResourceTag/switch:managed-by"] == "switch-hosted-controller"
      if contains(["ManageOwned", "SetDataRetentionAndUserData"], statement.Sid)
    ])
    error_message = "Lifecycle permissions require the full controller ownership marker."
  }
  assert {
    condition     = one([for statement in jsondecode(aws_iam_role_policy.controller.policy).Statement : statement if statement.Sid == "SetDataRetentionAndUserData"]).Condition.StringEquals["ec2:Attribute"] == ["blockDeviceMapping", "userData"]
    error_message = "Controller may modify only the data retention and the user data of its instances."
  }
  assert {
    condition     = one([for statement in jsondecode(aws_iam_role_policy.controller.policy).Statement : statement if statement.Sid == "CreateManagedRoot"]).Condition.NumericEquals["ec2:VolumeSize"] == var.root_volume_gib
    error_message = "Root storage must be constrained separately from data storage."
  }
  assert {
    condition     = one([for statement in jsondecode(aws_iam_role_policy.controller.policy).Statement : statement if statement.Sid == "CreateManagedData"]).Condition.NumericEquals["ec2:VolumeSize"] == var.data_volume_gib
    error_message = "Data creation must be constrained to the approved capacity."
  }
  assert {
    condition     = one([for statement in jsondecode(aws_iam_role_policy.controller.policy).Statement : statement if statement.Sid == "RequireMetadataTokens"]).Condition.StringNotEquals["ec2:MetadataHttpTokens"] == "required"
    error_message = "Controller launch must require IMDSv2."
  }
  assert {
    condition     = length(aws_iam_role.machine.name) <= 64 && length(aws_iam_role.controller.name) <= 64
    error_message = "IAM role names must stay within AWS limits."
  }
  assert {
    condition     = length(aws_security_group.worker.ingress) == 0
    error_message = "Workers must not expose inbound ports."
  }
}
