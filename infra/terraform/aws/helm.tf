# ---------------------------------------------------------------------------
# Kubernetes and Helm providers — configured from the EKS cluster
# ---------------------------------------------------------------------------

data "aws_eks_cluster" "target" {
  name = local.create_cluster ? aws_eks_cluster.this[0].name : var.existing_cluster_name

  depends_on = [aws_eks_cluster.this]
}

data "aws_eks_cluster_auth" "target" {
  name = local.create_cluster ? aws_eks_cluster.this[0].name : var.existing_cluster_name

  depends_on = [aws_eks_cluster.this]
}

provider "kubernetes" {
  host                   = data.aws_eks_cluster.target.endpoint
  cluster_ca_certificate = base64decode(data.aws_eks_cluster.target.certificate_authority[0].data)
  token                  = data.aws_eks_cluster_auth.target.token
}

provider "helm" {
  kubernetes {
    host                   = data.aws_eks_cluster.target.endpoint
    cluster_ca_certificate = base64decode(data.aws_eks_cluster.target.certificate_authority[0].data)
    token                  = data.aws_eks_cluster_auth.target.token
  }
}

# ---------------------------------------------------------------------------
# Namespace
# ---------------------------------------------------------------------------

resource "kubernetes_namespace" "lantern" {
  metadata {
    name = "lantern"

    labels = {
      "app.kubernetes.io/part-of"    = "lantern-data-plane"
      "app.kubernetes.io/managed-by" = "terraform"
    }
  }

  depends_on = [aws_eks_node_group.this]
}

# ---------------------------------------------------------------------------
# Deploy lantern-data-plane Helm chart
# ---------------------------------------------------------------------------

resource "helm_release" "lantern_data_plane" {
  name       = "lantern-dp"
  namespace  = kubernetes_namespace.lantern.metadata[0].name
  chart      = "${path.module}/../../helm/lantern-data-plane"
  version    = var.lantern_version
  wait       = true
  timeout    = 600

  set {
    name  = "controlPlane.endpoint"
    value = var.lantern_control_plane_endpoint
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
    name  = "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = aws_iam_role.data_plane.arn
  }

  # Use the S3 bucket instead of MinIO in production.
  set {
    name  = "minio.enabled"
    value = "false"
  }

  set {
    name  = "minio.external.endpoint"
    value = "https://s3.${var.region}.amazonaws.com"
  }

  set {
    name  = "minio.external.bucket"
    value = aws_s3_bucket.bundles.id
  }

  depends_on = [
    kubernetes_namespace.lantern,
    aws_eks_node_group.this,
  ]
}
