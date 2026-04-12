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

variable "lantern_control_plane_endpoint" {
  description = "Endpoint of the Lantern control plane (e.g., https://api.lantern.run)."
  type        = string
  default     = "https://api.lantern.run"
}

variable "tenant_id" {
  description = "Lantern tenant ID provisioned during onboarding."
  type        = string
}

variable "agent_token" {
  description = "Short-lived token for data plane agent authentication. Store securely."
  type        = string
  sensitive   = true
}

variable "lantern_version" {
  description = "Version of the Lantern data plane Helm chart to deploy."
  type        = string
  default     = "0.1.0"
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
    "managed-by" = "lantern-terraform"
    "component"  = "data-plane"
  }
}
