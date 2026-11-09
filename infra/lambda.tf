variable "chunk_seconds" {
  type    = number
  default = 15
}

variable "worker_memory_mb" {
  type    = number
  default = 10240
}

data "aws_ecr_image" "worker" {
  repository_name = aws_ecr_repository.worker.name
  image_tag       = var.worker_image_tag
}

resource "aws_ecr_repository_policy" "worker_lambda" {
  repository = aws_ecr_repository.worker.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
      Condition = { StringLike = { "aws:sourceArn" = "arn:aws:lambda:${var.region}:${data.aws_caller_identity.current.account_id}:function:*" } }
    }]
  })
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "worker_lambda" {
  name               = "${local.name}-worker-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_cloudwatch_log_group" "worker_lambda" {
  name              = "/aws/lambda/${local.name}-worker"
  retention_in_days = 7
}

data "aws_iam_policy_document" "worker_lambda" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.worker_lambda.arn}:*"]
  }

  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.videos.arn}/uploads/*", "${aws_s3_bucket.videos.arn}/work/*"]
  }

  statement {
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.videos.arn}/work/*", "${aws_s3_bucket.videos.arn}/processed/*"]
  }
}

resource "aws_iam_role_policy" "worker_lambda" {
  name   = "worker"
  role   = aws_iam_role.worker_lambda.id
  policy = data.aws_iam_policy_document.worker_lambda.json
}

resource "aws_lambda_function" "worker" {
  function_name = "${local.name}-worker"
  role          = aws_iam_role.worker_lambda.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.worker.repository_url}@${data.aws_ecr_image.worker.image_digest}"
  architectures = ["x86_64"]
  memory_size   = var.worker_memory_mb
  timeout       = 900

  environment {
    variables = { CHUNK_SECONDS = tostring(var.chunk_seconds) }
  }

  ephemeral_storage {
    size = 10240
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.worker_lambda.name
  }

  depends_on = [aws_ecr_repository_policy.worker_lambda, aws_iam_role_policy.worker_lambda]
}
