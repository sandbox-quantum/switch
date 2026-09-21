resource "aws_vpc" "worker" {
  cidr_block           = var.worker_vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = local.tags
}
resource "aws_subnet" "worker" {
  vpc_id                  = aws_vpc.worker.id
  cidr_block              = var.private_subnet_cidr
  availability_zone       = var.availability_zone
  map_public_ip_on_launch = false
  tags                    = local.tags
}
resource "aws_subnet" "nat" {
  vpc_id                  = aws_vpc.worker.id
  cidr_block              = var.public_subnet_cidr
  availability_zone       = var.availability_zone
  map_public_ip_on_launch = false
  tags                    = local.tags
}
resource "aws_internet_gateway" "worker" {
  vpc_id = aws_vpc.worker.id
  tags   = local.tags
}
resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = local.tags
}
resource "aws_nat_gateway" "worker" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.nat.id
  tags          = local.tags
  depends_on    = [aws_internet_gateway.worker]
}
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.worker.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.worker.id
  }
  tags = local.tags
}
resource "aws_route_table_association" "nat" {
  subnet_id      = aws_subnet.nat.id
  route_table_id = aws_route_table.public.id
}
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.worker.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.worker.id
  }
  tags = local.tags
}
resource "aws_route_table_association" "worker" {
  subnet_id      = aws_subnet.worker.id
  route_table_id = aws_route_table.private.id
}
resource "aws_network_acl" "worker" {
  vpc_id     = aws_vpc.worker.id
  subnet_ids = [aws_subnet.worker.id]
  tags       = local.tags
}
resource "aws_network_acl_rule" "deny_private_egress" {
  for_each = {
    "10" = "10.0.0.0/8"
    "20" = "172.16.0.0/12"
    "30" = "192.168.0.0/16"
  }
  network_acl_id = aws_network_acl.worker.id
  egress         = true
  rule_number    = tonumber(each.key)
  protocol       = "-1"
  rule_action    = "deny"
  cidr_block     = each.value
}
resource "aws_network_acl_rule" "web_egress" {
  for_each       = { "100" = 80, "110" = 443 }
  network_acl_id = aws_network_acl.worker.id
  egress         = true
  rule_number    = tonumber(each.key)
  protocol       = "tcp"
  rule_action    = "allow"
  cidr_block     = "0.0.0.0/0"
  from_port      = each.value
  to_port        = each.value
}
resource "aws_network_acl_rule" "responses" {
  network_acl_id = aws_network_acl.worker.id
  egress         = false
  rule_number    = 100
  protocol       = "tcp"
  rule_action    = "allow"
  cidr_block     = "0.0.0.0/0"
  from_port      = 1024
  to_port        = 65535
}
