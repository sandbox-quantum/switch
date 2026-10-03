variable "installation_id" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,39}$", var.installation_id))
    error_message = "Use a lowercase installation identifier of 3–40 characters."
  }
}
variable "availability_zone" { type = string }
variable "worker_vpc_cidr" { type = string }
variable "public_subnet_cidr" { type = string }
variable "private_subnet_cidr" { type = string }
variable "worker_image_id" { type = string }
variable "oidc_provider_arn" { type = string }
variable "oidc_issuer_url" { type = string }
variable "namespace" { type = string }
variable "service_account" { type = string }
variable "allowed_instance_types" {
  type    = set(string)
  default = ["c7i.2xlarge"]
  validation {
    condition     = length(var.allowed_instance_types) > 0
    error_message = "At least one explicitly approved worker type is required."
  }
}
variable "machine_slots" {
  description = "Pre-created per-machine-slot secrets; never put secret values in Terraform."
  type        = map(object({ secret_arn = string, kms_key_arn = string }))
  validation {
    condition     = length(var.machine_slots) > 0 && alltrue([for id in keys(var.machine_slots) : can(regex("^[a-z0-9][a-z0-9-]{2,39}$", id))])
    error_message = "Declare at least one machine slot using lowercase 3–40 character IDs."
  }
  validation {
    condition     = length(distinct([for slot in values(var.machine_slots) : slot.secret_arn])) == length(var.machine_slots)
    error_message = "Each machine slot must have a distinct assignment secret."
  }
}

variable "root_volume_gib" {
  type    = number
  default = 20
  validation {
    condition     = var.root_volume_gib >= 8 && var.root_volume_gib <= 128 && floor(var.root_volume_gib) == var.root_volume_gib
    error_message = "Pilot root disk must be 8–128 GiB."
  }
}
variable "data_volume_gib" {
  type    = number
  default = 200
  validation {
    condition     = var.data_volume_gib >= 8 && var.data_volume_gib <= 1024 && floor(var.data_volume_gib) == var.data_volume_gib
    error_message = "Pilot data disk must be 8–1024 GiB."
  }
}
