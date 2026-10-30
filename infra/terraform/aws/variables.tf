variable "cluster_name" {
  description = "Name of the EKS cluster to create or use."
  type        = string
  default     = "lantern-data-plane"
}

variable "region" {
  description = "AWS region for the data plane."
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = "EC2 instance type for the EKS node group. Use m5.metal or m6i.metal for Firecracker support."
  type        = string
  default     = "m5.xlarge"
}

variable "node_count" {
  description = "Number of nodes in the EKS node group."
  type        = number
  default     = 3
}

variable "node_min_count" {
  description = "Minimum number of nodes for autoscaling."
  type        = number
  default     = 2
}

variable "node_max_count" {
  description = "Maximum number of nodes for autoscaling."
  type        = number
  default     = 10
}

variable "existing_cluster_name" {
  description = "Name of an existing EKS cluster to use. If set, no new cluster is created."
  type        = string
  default     = ""
}

variable "kubernetes_version" {
  description = "Kubernetes version for the EKS cluster."
  type        = string
  default     = "1.29"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC. Ignored if using an existing cluster."
  type        = string
  default     = "10.0.0.0/16"
}

variable "existing_vpc_id" {
  description = "ID of an existing VPC. If set, no new VPC is created."
  type        = string
  default     = ""
}

variable "existing_subnet_ids" {
  description = "List of existing subnet IDs. Required if existing_vpc_id is set."
  type        = list(string)
  default     = []
}

variable "pal_control_plane_endpoint" {
  description = "Endpoint of the PAL Runtime control plane (default https://api.lantern.run)."
  type        = string
  default     = null
}

variable "lantern_control_plane_endpoint" {
  description = "Deprecated alias of pal_control_plane_endpoint; still honored when the PAL name is unset."
  type        = string
  default     = null
}

variable "tenant_id" {
  description = "PAL Runtime tenant ID provisioned during onboarding."
  type        = string
}

variable "agent_token" {
  description = "Short-lived token for data plane agent authentication. Store securely."
  type        = string
  sensitive   = true
}

variable "pal_version" {
  description = "Version of the PAL Runtime data plane Helm chart to deploy (default 0.1.0)."
  type        = string
  default     = null
}

variable "lantern_version" {
  description = "Deprecated alias of pal_version; still honored when the PAL name is unset."
  type        = string
  default     = null
}

locals {
  control_plane_endpoint = coalesce(var.pal_control_plane_endpoint, var.lantern_control_plane_endpoint, "https://api.lantern.run")
  chart_version          = coalesce(var.pal_version, var.lantern_version, "0.1.0")
}

variable "firecracker_enabled" {
  description = "Enable Firecracker microVM support. Requires bare-metal or nested-virt-capable instances."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags to apply to all AWS resources."
  type        = map(string)
  default = {
    "managed-by" = "pal-terraform"
    "component"  = "data-plane"
  }
}

# ---------------------------------------------------------------------------
# Multi-region (ADR 0046) — both default to off (single-region, unchanged)
# ---------------------------------------------------------------------------

variable "pal_control_plane_endpoints" {
  description = "Ordered control-plane endpoints, one per region, primary first. The data-plane agent connects to the first whose gRPC health check reports SERVING and fails back when a higher-priority one recovers. Empty = pal_control_plane_endpoint only."
  type        = list(string)
  default     = []
}

variable "bundles_replica_region" {
  description = "AWS region to cross-region-replicate the bundles/snapshots bucket to (e.g. us-west-2). Empty = no replication."
  type        = string
  default     = ""

  validation {
    condition     = var.bundles_replica_region == "" || can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]$", var.bundles_replica_region))
    error_message = "bundles_replica_region must be an AWS region name such as us-west-2, or empty."
  }
}
