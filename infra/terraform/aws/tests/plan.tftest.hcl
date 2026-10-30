# Credential-free plan of the EKS data plane: every provider is mocked, so this
# proves the graph plans with example inputs and pins the wiring that matters.
# Run: terraform init -backend=false && terraform test

mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-east-1a", "us-east-1b", "us-east-1c"] }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_eks_cluster" {
    defaults = {
      endpoint              = "https://example.eks.amazonaws.com"
      certificate_authority = [{ data = "Y2E=" }]
      identity              = [{ oidc = [{ issuer = "https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE" }] }]
    }
  }
  mock_resource "aws_eks_cluster" {
    defaults = {
      identity = [{ oidc = [{ issuer = "https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE" }] }]
    }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::mock-bucket" }
  }
  mock_resource "aws_iam_openid_connect_provider" {
    defaults = { arn = "arn:aws:iam::123456789012:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE" }
  }
  mock_data "aws_iam_openid_connect_provider" {
    defaults = { arn = "arn:aws:iam::123456789012:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/EXISTING" }
  }
}

# replication.tf declares an aliased aws.replica provider; without its own mock
# terraform test falls back to the real provider and fails looking for creds.
mock_provider "aws" {
  alias = "replica"
}

mock_provider "tls" {
  mock_data "tls_certificate" {
    defaults = { certificates = [{ sha1_fingerprint = "9e99a48a9960b14926bb7f3b02e22da2b0ab7280" }] }
  }
}

mock_provider "kubernetes" {}
mock_provider "helm" {}

variables {
  tenant_id   = "00000000-0000-0000-0000-000000000001"
  agent_token = "example-token"
}

run "new_cluster" {
  command = apply # mocked: nothing is created; apply resolves computed values for the asserts

  assert {
    condition     = length(aws_subnet.private) == 3 && length(aws_eks_cluster.this) == 1
    error_message = "a new cluster should get a VPC with 3 private subnets"
  }
  assert {
    condition     = jsondecode(aws_iam_role.data_plane.assume_role_policy).Statement[0].Principal.Federated == aws_iam_openid_connect_provider.eks[0].arn
    error_message = "IRSA trust must federate the OIDC provider ARN, not the issuer URL"
  }
  assert {
    condition     = jsondecode(aws_iam_role.data_plane.assume_role_policy).Statement[0].Condition.StringEquals["oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE:sub"] == "system:serviceaccount:lantern:pal-data-plane"
    error_message = "IRSA subject must be the chart's service account"
  }
  assert {
    condition     = helm_release.pal_data_plane.dependency_update
    error_message = "the local chart's Bitnami deps are not vendored; dependency_update must be on"
  }
}

run "existing_cluster_needs_subnets" {
  command = plan
  variables {
    existing_cluster_name = "prod-eks"
  }
  expect_failures = [aws_eks_node_group.this]
}

run "existing_cluster" {
  command = plan
  variables {
    existing_cluster_name = "prod-eks"
    existing_subnet_ids   = ["subnet-aaa", "subnet-bbb"]
  }
  assert {
    condition     = length(aws_vpc.this) == 0 && length(aws_eks_cluster.this) == 0 && length(aws_iam_openid_connect_provider.eks) == 0
    error_message = "an existing cluster must not create a VPC, cluster or OIDC provider"
  }
}

run "image_tag_prefers_pal_version" {
  command = plan
  variables {
    pal_version     = "1.2.3"
    lantern_version = "0.9.0"
  }
  assert {
    condition     = contains([for s in helm_release.pal_data_plane.set : s.value if s.name == "global.image.tag"], "1.2.3")
    error_message = "pal_version must set the image tag"
  }
}

run "image_tag_falls_back_to_lantern_version" {
  command = plan
  variables {
    lantern_version = "0.9.0"
  }
  assert {
    condition     = contains([for s in helm_release.pal_data_plane.set : s.value if s.name == "global.image.tag"], "0.9.0")
    error_message = "deprecated lantern_version must still set the image tag"
  }
}
