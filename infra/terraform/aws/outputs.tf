output "cluster_name" {
  description = "Name of the EKS cluster."
  value       = local.cluster_name
}

output "cluster_endpoint" {
  description = "Endpoint of the EKS cluster API server."
  value       = data.aws_eks_cluster.target.endpoint
}

output "kubeconfig_command" {
  description = "Command to configure kubectl for the EKS cluster."
  value       = "aws eks update-kubeconfig --name ${local.cluster_name} --region ${var.region}"
}

output "data_plane_status" {
  description = "Instructions to verify the data plane connection."
  value       = <<-EOT
    Data plane deployed to EKS cluster: ${local.cluster_name}
    Control plane endpoint: ${var.lantern_control_plane_endpoint}
    Tenant ID: ${var.tenant_id}

    Verify the connection:
      ${self.kubeconfig_command}
      kubectl -n lantern logs -l app.kubernetes.io/component=data-plane-agent -f
      kubectl -n lantern port-forward svc/lantern-dp-lantern-data-plane-data-plane-agent 8090:8090
      curl http://localhost:8090/status
  EOT
}

output "s3_bucket" {
  description = "S3 bucket for agent bundles and snapshots."
  value       = aws_s3_bucket.bundles.id
}

output "node_group_role_arn" {
  description = "ARN of the IAM role for the EKS node group."
  value       = aws_iam_role.node_group.arn
}

output "data_plane_role_arn" {
  description = "ARN of the IAM role for the data plane service account (IRSA)."
  value       = aws_iam_role.data_plane.arn
}
