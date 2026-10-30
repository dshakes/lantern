terraform {
  required_version = ">= 1.5"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.80"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.12"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.25"
    }
  }
}

provider "azurerm" {
  features {}
}

locals {
  create_cluster      = var.existing_cluster_name == ""
  cluster_name        = local.create_cluster ? var.cluster_name : var.existing_cluster_name
  resource_group_name = local.create_cluster ? var.resource_group_name : var.existing_resource_group
}

# ---------------------------------------------------------------------------
# Resource Group
# ---------------------------------------------------------------------------

resource "azurerm_resource_group" "this" {
  count = local.create_cluster ? 1 : 0

  name     = var.resource_group_name
  location = var.location
  tags     = var.tags
}

locals {
  rg_name     = local.create_cluster ? azurerm_resource_group.this[0].name : var.existing_resource_group
  rg_location = local.create_cluster ? azurerm_resource_group.this[0].location : var.location
}

# ---------------------------------------------------------------------------
# Virtual Network
# ---------------------------------------------------------------------------

resource "azurerm_virtual_network" "this" {
  count = local.create_cluster ? 1 : 0

  name                = "${var.cluster_name}-vnet"
  address_space       = [var.vnet_cidr]
  location            = local.rg_location
  resource_group_name = local.rg_name
  tags                = var.tags
}

resource "azurerm_subnet" "aks" {
  count = local.create_cluster ? 1 : 0

  name                 = "${var.cluster_name}-aks-subnet"
  resource_group_name  = local.rg_name
  virtual_network_name = azurerm_virtual_network.this[0].name
  address_prefixes     = [var.subnet_cidr]
}

# NAT Gateway for outbound connectivity.
resource "azurerm_public_ip" "nat" {
  count = local.create_cluster ? 1 : 0

  name                = "${var.cluster_name}-nat-ip"
  location            = local.rg_location
  resource_group_name = local.rg_name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = var.tags
}

resource "azurerm_nat_gateway" "this" {
  count = local.create_cluster ? 1 : 0

  name                = "${var.cluster_name}-nat"
  location            = local.rg_location
  resource_group_name = local.rg_name
  sku_name            = "Standard"
  tags                = var.tags
}

resource "azurerm_nat_gateway_public_ip_association" "this" {
  count = local.create_cluster ? 1 : 0

  nat_gateway_id       = azurerm_nat_gateway.this[0].id
  public_ip_address_id = azurerm_public_ip.nat[0].id
}

resource "azurerm_subnet_nat_gateway_association" "this" {
  count = local.create_cluster ? 1 : 0

  subnet_id      = azurerm_subnet.aks[0].id
  nat_gateway_id = azurerm_nat_gateway.this[0].id
}

# ---------------------------------------------------------------------------
# Managed Identity for the data plane
# ---------------------------------------------------------------------------

resource "azurerm_user_assigned_identity" "data_plane" {
  name                = "${local.cluster_name}-data-plane-identity"
  location            = local.rg_location
  resource_group_name = local.rg_name
  tags                = var.tags
}

# ---------------------------------------------------------------------------
# Storage Account and Container for agent bundles
# ---------------------------------------------------------------------------

resource "azurerm_storage_account" "bundles" {
  # Storage account names are GLOBALLY unique (3-24 lowercase alphanumerics), so
  # suffix a stable hash of subscription + resource group + cluster.
  name                            = "${substr(replace(lower(local.cluster_name), "/[^a-z0-9]/", ""), 0, 10)}b${substr(sha1("${data.azurerm_subscription.current.subscription_id}/${local.rg_name}/${local.cluster_name}"), 0, 12)}"
  allow_nested_items_to_be_public = false
  resource_group_name             = local.rg_name
  location                        = local.rg_location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"

  blob_properties {
    versioning_enabled = true
  }

  tags = var.tags
}

resource "azurerm_storage_container" "bundles" {
  name                  = "pal-bundles"
  storage_account_name  = azurerm_storage_account.bundles.name
  container_access_type = "private"
}

# Grant the managed identity access to the storage account.
resource "azurerm_role_assignment" "data_plane_storage" {
  scope                = azurerm_storage_account.bundles.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.data_plane.principal_id
}

# ---------------------------------------------------------------------------
# AKS Cluster (created only if no existing cluster is provided)
# ---------------------------------------------------------------------------

resource "azurerm_kubernetes_cluster" "this" {
  count = local.create_cluster ? 1 : 0

  name                = var.cluster_name
  location            = local.rg_location
  resource_group_name = local.rg_name
  dns_prefix          = var.cluster_name
  kubernetes_version  = var.kubernetes_version

  default_node_pool {
    name                = "system"
    node_count          = 1
    vm_size             = "Standard_D2s_v5"
    vnet_subnet_id      = azurerm_subnet.aks[0].id
    enable_auto_scaling = false
  }

  identity {
    type = "SystemAssigned"
  }

  network_profile {
    network_plugin = "azure"
    network_policy = "calico"
  }

  oidc_issuer_enabled       = true
  workload_identity_enabled = true

  tags = var.tags
}

# ---------------------------------------------------------------------------
# AKS Node Pool for PAL Runtime workloads
# ---------------------------------------------------------------------------

resource "azurerm_kubernetes_cluster_node_pool" "pal" {
  name                  = "pal"
  kubernetes_cluster_id = data.azurerm_kubernetes_cluster.target.id
  vm_size               = var.vm_size
  node_count            = var.node_count
  min_count             = var.node_min_count
  max_count             = var.node_max_count
  enable_auto_scaling   = true

  node_labels = {
    "pal.run/component" = "data-plane"
  }

  tags = var.tags
}

data "azurerm_subscription" "current" {}

# ---------------------------------------------------------------------------
# Federated Identity Credential for Workload Identity
# ---------------------------------------------------------------------------

# For BOTH new and existing clusters: without it Workload Identity silently
# yields no token. An existing cluster must have the OIDC issuer enabled.
resource "azurerm_federated_identity_credential" "data_plane" {
  name                = "pal-data-plane"
  resource_group_name = local.rg_name
  parent_id           = azurerm_user_assigned_identity.data_plane.id
  audience            = ["api://AzureADTokenExchange"]
  issuer              = data.azurerm_kubernetes_cluster.target.oidc_issuer_url

  lifecycle {
    precondition {
      condition     = data.azurerm_kubernetes_cluster.target.oidc_issuer_url != ""
      error_message = "The AKS cluster has no OIDC issuer: enable it (az aks update --enable-oidc-issuer --enable-workload-identity)."
    }
  }
  subject = "system:serviceaccount:pal:pal-data-plane"
}

# ---------------------------------------------------------------------------
# Kubernetes and Helm providers
# ---------------------------------------------------------------------------

data "azurerm_kubernetes_cluster" "target" {
  name                = local.cluster_name
  resource_group_name = local.rg_name

  depends_on = [azurerm_kubernetes_cluster.this]
}

provider "kubernetes" {
  host                   = data.azurerm_kubernetes_cluster.target.kube_config[0].host
  client_certificate     = base64decode(data.azurerm_kubernetes_cluster.target.kube_config[0].client_certificate)
  client_key             = base64decode(data.azurerm_kubernetes_cluster.target.kube_config[0].client_key)
  cluster_ca_certificate = base64decode(data.azurerm_kubernetes_cluster.target.kube_config[0].cluster_ca_certificate)
}

provider "helm" {
  kubernetes {
    host                   = data.azurerm_kubernetes_cluster.target.kube_config[0].host
    client_certificate     = base64decode(data.azurerm_kubernetes_cluster.target.kube_config[0].client_certificate)
    client_key             = base64decode(data.azurerm_kubernetes_cluster.target.kube_config[0].client_key)
    cluster_ca_certificate = base64decode(data.azurerm_kubernetes_cluster.target.kube_config[0].cluster_ca_certificate)
  }
}

# ---------------------------------------------------------------------------
# Namespace
# ---------------------------------------------------------------------------

resource "kubernetes_namespace" "pal" {
  metadata {
    name = "pal"

    labels = {
      "app.kubernetes.io/part-of"    = "pal-data-plane"
      "app.kubernetes.io/managed-by" = "terraform"
    }
  }

  depends_on = [azurerm_kubernetes_cluster_node_pool.pal]
}

# ---------------------------------------------------------------------------
# Deploy pal-data-plane Helm chart
# ---------------------------------------------------------------------------

resource "helm_release" "pal_data_plane" {
  name      = "pal-dp"
  namespace = kubernetes_namespace.pal.metadata[0].name
  chart     = "${path.module}/../../helm/pal-data-plane"
  # Local chart: Bitnami postgresql/redis deps (Chart.lock) are not vendored,
  # so helm must fetch them or the release fails "missing in charts/".
  dependency_update = true
  wait              = true
  timeout           = 600

  set {
    name  = "global.image.tag"
    value = local.chart_version
  }

  set {
    name  = "controlPlane.endpoint"
    value = local.control_plane_endpoint
  }

  set {
    name  = "controlPlane.tenantId"
    value = var.tenant_id
  }

  set_sensitive {
    name  = "controlPlane.agentToken"
    value = var.agent_token
  }

  set {
    name  = "runtimeManager.firecrackerEnabled"
    value = tostring(var.firecracker_enabled)
  }

  set {
    name  = "serviceAccount.annotations.azure\\.workload\\.identity/client-id"
    value = azurerm_user_assigned_identity.data_plane.client_id
  }

  # Use Azure Blob Storage instead of MinIO in production.
  set {
    name  = "minio.enabled"
    value = "false"
  }

  set {
    name  = "minio.external.endpoint"
    value = azurerm_storage_account.bundles.primary_blob_endpoint
  }

  set {
    name  = "minio.external.bucket"
    value = azurerm_storage_container.bundles.name
  }

  depends_on = [
    kubernetes_namespace.pal,
    azurerm_kubernetes_cluster_node_pool.pal,
  ]
}

