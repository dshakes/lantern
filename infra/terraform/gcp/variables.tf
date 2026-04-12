variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "cluster_name" {
  description = "Name of the GKE cluster to create or use."
  type        = string
  default     = "lantern-data-plane"
}

variable "region" {
  description = "GCP region for the data plane."
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "GCP zone for zonal clusters. Leave empty for regional clusters."
  type        = string
  default     = ""
}

variable "machine_type" {
  description = "GCE machine type for the GKE node pool. Use n2-standard-* with nested virt or c2d-metal-* for Firecracker."
  type        = string
  default     = "n2-standard-4"
}

variable "node_count" {
  description = "Number of nodes per zone in the GKE node pool."
  type        = number
  default     = 1
}

variable "node_min_count" {
  description = "Minimum number of nodes per zone for autoscaling."
  type        = number
  default     = 1
}

variable "node_max_count" {
  description = "Maximum number of nodes per zone for autoscaling."
  type        = number
  default     = 5
}

variable "existing_cluster_name" {
  description = "Name of an existing GKE cluster to use. If set, no new cluster is created."
  type        = string
  default     = ""
}

variable "kubernetes_version" {
  description = "Kubernetes version for the GKE cluster."
  type        = string
  default     = "1.29"
}

variable "network" {
  description = "VPC network name. Created if it does not exist."
  type        = string
  default     = "lantern-data-plane-vpc"
}

variable "subnetwork" {
  description = "Subnetwork name. Created if it does not exist."
  type        = string
  default     = "lantern-data-plane-subnet"
}

variable "subnet_cidr" {
  description = "CIDR range for the subnetwork."
  type        = string
  default     = "10.0.0.0/20"
}

variable "pods_cidr" {
  description = "Secondary CIDR range for pods."
  type        = string
  default     = "10.4.0.0/14"
}

variable "services_cidr" {
  description = "Secondary CIDR range for services."
  type        = string
  default     = "10.8.0.0/20"
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

variable "labels" {
  description = "Labels to apply to all GCP resources."
  type        = map(string)
  default = {
    "managed-by" = "lantern-terraform"
    "component"  = "data-plane"
  }
}
