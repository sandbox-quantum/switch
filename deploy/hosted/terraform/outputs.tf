output "controller_role_arn" { value = aws_iam_role.controller.arn }
output "worker_security_group_id" { value = aws_security_group.worker.id }
output "availability_zone" { value = aws_subnet.worker.availability_zone }
output "machine_instance_profile_arn" { value = aws_iam_instance_profile.machine.arn }
output "worker_subnet_id" { value = aws_subnet.worker.id }
