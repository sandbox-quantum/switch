mock_provider "aws" {
  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::000000000000:policy/example-assignments" }
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
  machine_slots = {
    "example-slot" = {
      secret_arn  = "arn:aws:secretsmanager:us-east-1:000000000000:secret:example-slot-ABCDEF"
      kms_key_arn = "arn:aws:kms:us-east-1:000000000000:key/00000000-0000-0000-0000-000000000000"
    }
  }
}

run "isolated_plan" {
  command = plan
  assert {
    condition     = aws_subnet.worker.map_public_ip_on_launch == false
    error_message = "Worker subnet must not assign public IPs."
  }
  assert {
    condition     = aws_iam_role_policy.worker_secret["example-slot"].policy != ""
    error_message = "Assignment role must have an explicit scoped policy."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.worker_secret["example-slot"].policy).Statement[0].Resource == var.machine_slots["example-slot"].secret_arn
    error_message = "Worker secret access must be scoped to exactly its assignment."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.worker_secret["example-slot"].policy).Statement[1].Condition.StringEquals["kms:EncryptionContext:SecretARN"] == var.machine_slots["example-slot"].secret_arn
    error_message = "KMS decrypt must be restricted to the assignment secret."
  }
  assert {
    condition     = alltrue([for rule in aws_network_acl_rule.deny_private_egress : rule.rule_action == "deny" && rule.rule_number < 100])
    error_message = "Private-destination deny rules must precede Internet allow rules."
  }
}

run "rendered_permissions" {
  command = apply
  assert {
    condition     = jsondecode(aws_iam_policy.controller_assignments.policy).Statement[0].Resource == [var.machine_slots["example-slot"].secret_arn]
    error_message = "Controller secret writes must remain scoped to assigned secrets."
  }
  assert {
    condition     = contains(jsondecode(aws_iam_policy.controller_assignments.policy).Statement[0].Action, "secretsmanager:UpdateSecretVersionStage")
    error_message = "Controller must be able to promote a written bundle to AWSCURRENT on its assigned secrets."
  }
  assert {
    condition = alltrue([for statement in jsondecode(aws_iam_role_policy.controller.policy).Statement :
      statement.Condition.Null[startswith(statement.Sid, "CreateManaged") || statement.Sid == "TagOnCreate" ? "aws:RequestTag/switch:generation" : "ec2:ResourceTag/switch:generation"] == "false"
      && !contains(keys(statement.Condition.StringEquals), "aws:RequestTag/switch:generation")
      && !contains(keys(statement.Condition.StringEquals), "ec2:ResourceTag/switch:generation")
      if contains(["CreateManagedLaunchResources", "CreateManagedRoot", "CreateManagedData", "TagOnCreate", "ManageOwned", "PreserveAttachedData"], statement.Sid)
    ]) && length([for statement in jsondecode(aws_iam_role_policy.controller.policy).Statement : statement if contains(["CreateManagedLaunchResources", "CreateManagedRoot", "CreateManagedData", "TagOnCreate", "ManageOwned", "PreserveAttachedData"], statement.Sid)]) == length(["CreateManagedLaunchResources", "CreateManagedRoot", "CreateManagedData", "TagOnCreate", "ManageOwned", "PreserveAttachedData"])
    error_message = "Managed resources must carry a generation tag of any value."
  }
  assert {
    condition = alltrue([for statement in jsondecode(aws_iam_role_policy.controller.policy).Statement :
      jsonencode(statement.Condition.StringLike) == jsonencode({ (contains(["ManageOwned", "PreserveAttachedData"], statement.Sid) ? "ec2:ResourceTag/switch:slot-id" : "aws:RequestTag/switch:slot-id") = keys(var.machine_slots) })
      if contains(["CreateManagedLaunchResources", "CreateManagedRoot", "CreateManagedData", "TagOnCreate", "ManageOwned", "PreserveAttachedData"], statement.Sid)
    ])
    error_message = "Managed resources must be scoped to the declared machine slots."
  }
  assert {
    condition     = output.machine_slots["example-slot"].assignment_secret_arn == var.machine_slots["example-slot"].secret_arn
    error_message = "The machine_slots output must map each slot to its assignment secret."
  }
  assert {
    condition     = var.data_volume_gib == 200 && one([for statement in jsondecode(aws_iam_role_policy.controller.policy).Statement : statement if statement.Sid == "DenyUnapprovedType"]).Condition.StringNotEquals["ec2:InstanceType"] == ["c7i.2xlarge"]
    error_message = "Defaults must allow c7i.2xlarge workers with 200 GiB data disks."
  }
  assert {
    condition     = aws_iam_role_policy_attachment.controller_assignments.role == aws_iam_role.controller.name && aws_iam_role_policy_attachment.controller_assignments.policy_arn == aws_iam_policy.controller_assignments.arn
    error_message = "Controller assignment policy must be attached to the controller role."
  }
  assert {
    condition = alltrue([for statement in jsondecode(aws_iam_role_policy.controller.policy).Statement :
      statement.Condition.StringEquals["ec2:ResourceTag/switch:managed-by"] == "switch-hosted-controller"
      if contains(["ManageOwned", "PreserveAttachedData"], statement.Sid)
    ])
    error_message = "Lifecycle permissions require the full controller ownership marker."
  }
  assert {
    condition = contains(
      flatten([for statement in jsondecode(aws_iam_role_policy.controller.policy).Statement : statement.Action]),
      "ec2:ModifyInstanceAttribute"
    )
    error_message = "Controller must be able to set explicit data retention."
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
    condition     = alltrue([for role in aws_iam_role.worker : length(role.name) <= 64]) && length(aws_iam_role.controller.name) <= 64
    error_message = "IAM role names must stay within AWS limits."
  }
  assert {
    condition     = length(aws_security_group.worker.ingress) == 0
    error_message = "Workers must not expose inbound ports."
  }
}
