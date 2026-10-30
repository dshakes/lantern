# ---------------------------------------------------------------------------
# Cross-region replication of the bundles/snapshots bucket (ADR 0046).
#
# Off unless var.bundles_replica_region is set. Agent bundles and VM snapshots
# are immutable, content-addressed objects, so asynchronous S3 CRR (with
# Replication Time Control: 99.99% of objects within 15 minutes) is the RPO for
# them. Delete markers are replicated so a GDPR purge reaches both copies.
# ---------------------------------------------------------------------------

locals {
  replicate_bundles = var.bundles_replica_region != ""
}

provider "aws" {
  alias  = "replica"
  region = local.replicate_bundles ? var.bundles_replica_region : var.region

  default_tags {
    tags = var.tags
  }
}

resource "aws_kms_key" "bundles_replica" {
  count    = local.replicate_bundles ? 1 : 0
  provider = aws.replica

  description         = "${local.cluster_name} pal bundles replica (${var.bundles_replica_region})"
  enable_key_rotation = true
}

resource "aws_s3_bucket" "bundles_replica" {
  count    = local.replicate_bundles ? 1 : 0
  provider = aws.replica

  bucket = "${local.cluster_name}-pal-bundles-${local.account_id}-${var.bundles_replica_region}"

  tags = {
    Name = "${local.cluster_name}-pal-bundles-replica"
  }
}

resource "aws_s3_bucket_versioning" "bundles_replica" {
  count    = local.replicate_bundles ? 1 : 0
  provider = aws.replica
  bucket   = aws_s3_bucket.bundles_replica[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "bundles_replica" {
  count    = local.replicate_bundles ? 1 : 0
  provider = aws.replica
  bucket   = aws_s3_bucket.bundles_replica[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.bundles_replica[0].arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "bundles_replica" {
  count    = local.replicate_bundles ? 1 : 0
  provider = aws.replica
  bucket   = aws_s3_bucket.bundles_replica[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_iam_role" "bundles_replication" {
  count = local.replicate_bundles ? 1 : 0
  name  = "${local.cluster_name}-pal-bundles-crr"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "s3.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "bundles_replication" {
  count = local.replicate_bundles ? 1 : 0
  name  = "${local.cluster_name}-pal-bundles-crr"
  role  = aws_iam_role.bundles_replication[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetReplicationConfiguration", "s3:ListBucket"]
        Resource = [aws_s3_bucket.bundles.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObjectVersionForReplication", "s3:GetObjectVersionAcl", "s3:GetObjectVersionTagging"]
        Resource = ["${aws_s3_bucket.bundles.arn}/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags"]
        Resource = ["${aws_s3_bucket.bundles_replica[0].arn}/*"]
      },
      {
        # Source objects use the account's S3 KMS key; scope Decrypt to S3 in
        # the source region acting on this bucket only.
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = ["*"]
        Condition = {
          StringEquals = { "kms:ViaService" = "s3.${var.region}.amazonaws.com" }
          StringLike   = { "kms:EncryptionContext:aws:s3:arn" = ["${aws_s3_bucket.bundles.arn}/*"] }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Encrypt", "kms:GenerateDataKey"]
        Resource = [aws_kms_key.bundles_replica[0].arn]
      },
    ]
  })
}

resource "aws_s3_bucket_replication_configuration" "bundles" {
  count = local.replicate_bundles ? 1 : 0

  # Versioning must be on at both ends before replication can be configured.
  depends_on = [aws_s3_bucket_versioning.bundles, aws_s3_bucket_versioning.bundles_replica]

  role   = aws_iam_role.bundles_replication[0].arn
  bucket = aws_s3_bucket.bundles.id

  rule {
    id     = "bundles-crr"
    status = "Enabled"

    filter {}

    delete_marker_replication {
      status = "Enabled"
    }

    source_selection_criteria {
      sse_kms_encrypted_objects {
        status = "Enabled"
      }
    }

    destination {
      bucket        = aws_s3_bucket.bundles_replica[0].arn
      storage_class = "STANDARD"

      encryption_configuration {
        replica_kms_key_id = aws_kms_key.bundles_replica[0].arn
      }

      replication_time {
        status = "Enabled"
        time {
          minutes = 15
        }
      }

      metrics {
        status = "Enabled"
        event_threshold {
          minutes = 15
        }
      }
    }
  }
}

output "bundles_replica_bucket" {
  description = "Cross-region replica of the bundles bucket (empty when replication is off)."
  value       = local.replicate_bundles ? aws_s3_bucket.bundles_replica[0].id : ""
}
