output "controller_role_arn" { value = aws_iam_role.controller.arn }
output "worker_security_group_id" { value = aws_security_group.worker.id }
output "availability_zone" { value = aws_subnet.worker.availability_zone }
output "machine_slots" {
  value = { for id, slot in var.machine_slots : id => {
    instance_profile_arn  = aws_iam_instance_profile.worker[id].arn
    assignment_secret_arn = slot.secret_arn
  } }
}

output "worker_subnet_id" { value = aws_subnet.worker.id }
