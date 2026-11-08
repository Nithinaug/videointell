import {
  to = aws_s3_bucket.videos
  id = local.bucket
}

import {
  to = aws_s3_bucket_public_access_block.videos
  id = local.bucket
}

import {
  to = aws_s3_bucket_ownership_controls.videos
  id = local.bucket
}

import {
  to = aws_s3_bucket_server_side_encryption_configuration.videos
  id = local.bucket
}

import {
  to = aws_s3_bucket_lifecycle_configuration.videos
  id = local.bucket
}

resource "aws_s3_bucket" "videos" {
  bucket = local.bucket

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "videos" {
  bucket                  = aws_s3_bucket.videos.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "videos" {
  bucket = aws_s3_bucket.videos.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "videos" {
  bucket = aws_s3_bucket.videos.id

  rule {
    bucket_key_enabled = true

    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "videos" {
  bucket = aws_s3_bucket.videos.id

  rule {
    id     = "expire-test-uploads"
    status = "Enabled"

    filter {
      prefix = "uploads/"
    }

    expiration {
      days = 3
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_notification" "videos" {
  bucket      = aws_s3_bucket.videos.id
  eventbridge = true
}
