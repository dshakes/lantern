variable "cluster_name" {
  description = "Name of the AKS cluster to create or use."
  type        = string
  default     = "lantern-data-plane"
}

variable "resource_group_name" {
  description = "Name of the Azure resource group."
  type        = string
  default     = "lantern-data-plane-rg"
}

variable "location" {
  description = "Azure region for the data plane."
  type        = string
  default     = "eastus"
}

variable "vm_size" {
  description = "Azure VM size for the AKS node pool. Use Standard_D*_v5 for nested virt or dedicated hosts for bare metal."
  type        = string
  default     = "Standard_D4s_v5"
}

variable "node_count" {
  description = "Number of nodes in the AKS node pool."
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
  description = "Name of an existing AKS cluster to use. If set, no new cluster is created."
  type        = string
  default     = ""
}

variable "existing_resource_group" {
  description = "Resource group of the existing AKS cluster. Required if existing_cluster_name is set."
  type        = string
  default     = ""
}

variable "kubernetes_version" {
  description = "Kubernetes version for the AKS cluster."
  type        = string
  default     = "1.29"
}

variable "vnet_cidr" {
  description = "CIDR block for the VNet. Ignored if using an existing cluster."
  type        = string
  default     = "10.0.0.0/16"
}

variable "subnet_cidr" {
  description = "CIDR block for the AKS subnet."
  type        = string
  default     = "10.0.0.0/20"
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
  description = "Short-lived token for data plane agent authentication."
  type        = string
  sensitive   = true
}

variable "lantern_version" {
  description = "Version of the Lantern data plane Helm chart to deploy."
  type        = string
  default     = "0.1.0"
}

variable "firecracker_enabled" {
  description = "Enable Firecracker microVM support."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags to apply to all Azure resources."
  type        = map(string)
  default = {
    "managed-by" = "lantern-terraform"
    "component"  = "data-plane"
  }
}
