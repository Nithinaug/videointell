resource "aws_cloudwatch_event_rule" "video_uploaded" {
  name        = "${local.name}-video-uploaded"
  description = "Upload finished: .done marker under uploads/ in the video bucket"

  event_pattern = jsonencode({
    source      = ["aws.s3"]
    detail-type = ["Object Created"]
    detail = {
      bucket = { name = [aws_s3_bucket.videos.id] }
      object = { key = [{ wildcard = "uploads/*.done" }] }
    }
  })
}

resource "aws_cloudwatch_log_group" "video_uploaded" {
  name              = "/aws/events/${local.name}-video-uploaded"
  retention_in_days = 7
}

data "aws_iam_policy_document" "events_to_logs" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.video_uploaded.arn}:*"]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com", "delivery.logs.amazonaws.com"]
    }
  }
}

resource "aws_cloudwatch_log_resource_policy" "events_to_logs" {
  policy_name     = "${local.name}-events-to-logs"
  policy_document = data.aws_iam_policy_document.events_to_logs.json
}

resource "aws_cloudwatch_event_target" "video_uploaded_log" {
  rule = aws_cloudwatch_event_rule.video_uploaded.name
  arn  = aws_cloudwatch_log_group.video_uploaded.arn
}

data "aws_iam_policy_document" "events_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "events_start_pipeline" {
  name               = "${local.name}-events-start-pipeline"
  assume_role_policy = data.aws_iam_policy_document.events_assume.json
}

data "aws_iam_policy_document" "events_start_pipeline" {
  statement {
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.pipeline.arn]
  }
}

resource "aws_iam_role_policy" "events_start_pipeline" {
  name   = "start-pipeline"
  role   = aws_iam_role.events_start_pipeline.id
  policy = data.aws_iam_policy_document.events_start_pipeline.json
}

resource "aws_cloudwatch_event_target" "video_uploaded_pipeline" {
  rule     = aws_cloudwatch_event_rule.video_uploaded.name
  arn      = aws_sfn_state_machine.pipeline.arn
  role_arn = aws_iam_role.events_start_pipeline.arn
}
