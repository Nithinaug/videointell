locals {
  throttling_errors = [
    "Rekognition.LimitExceededException",
    "Rekognition.ProvisionedThroughputExceededException",
    "Rekognition.ThrottlingException",
    "S3.SlowDownException",
  ]

  retry_throttling = [{
    ErrorEquals     = local.throttling_errors
    IntervalSeconds = 30
    BackoffRate     = 2
    MaxAttempts     = 6
    JitterStrategy  = "FULL"
  }]

  catch_all = [{
    ErrorEquals = ["States.ALL"]
    Next        = "NotifyFailed"
  }]

  pipeline_definition = {
    Comment        = "Process one finished upload, started by its .done marker"
    QueryLanguage  = "JSONata"
    TimeoutSeconds = 7200
    StartAt        = "Init"
    States = {
      Init = {
        Type = "Pass"
        Assign = {
          bucket   = "{% $states.input.detail.bucket.name %}"
          videoKey = "{% $substring($states.input.detail.object.key, 0, $length($states.input.detail.object.key) - 5) %}"
          out      = "{% 'processed/' & $substring($states.input.detail.object.key, 8, $length($states.input.detail.object.key) - 13) & '/' %}"
        }
        Next = "StartLabelDetection"
      }

      StartLabelDetection = {
        Type     = "Task"
        Resource = "arn:aws:states:::aws-sdk:rekognition:startLabelDetection"
        Arguments = {
          Video         = { S3Object = { Bucket = "{% $bucket %}", Name = "{% $videoKey %}" } }
          MinConfidence = 80
        }
        Assign = { labelJob = "{% $states.result.JobId %}" }
        Retry  = local.retry_throttling
        Catch  = local.catch_all
        Next   = "WaitForLabels"
      }

      WaitForLabels = {
        Type    = "Wait"
        Seconds = 20
        Next    = "GetLabels"
      }

      GetLabels = {
        Type      = "Task"
        Resource  = "arn:aws:states:::aws-sdk:rekognition:getLabelDetection"
        Arguments = { JobId = "{% $labelJob %}", MaxResults = 200, SortBy = "NAME" }
        Output = {
          status = "{% $states.result.JobStatus %}"
          labels = "{% $exists($states.result.Labels) ? $distinct($states.result.Labels.Label.Name[]) : [] %}"
        }
        Retry = local.retry_throttling
        Catch = local.catch_all
        Next  = "LabelsDone"
      }

      LabelsDone = {
        Type = "Choice"
        Choices = [
          { Condition = "{% $states.input.status = 'SUCCEEDED' %}", Next = "SaveLabels" },
          { Condition = "{% $states.input.status = 'FAILED' %}", Next = "NotifyFailed" },
        ]
        Default = "WaitForLabels"
      }

      SaveLabels = {
        Type     = "Task"
        Resource = "arn:aws:states:::aws-sdk:s3:putObject"
        Arguments = {
          Bucket      = "{% $bucket %}"
          Key         = "{% $out & 'labels.json' %}"
          Body        = "{% $string($states.input.labels) %}"
          ContentType = "application/json"
        }
        Retry = local.retry_throttling
        Catch = local.catch_all
        Next  = "NotifyReady"
      }

      NotifyReady = {
        Type     = "Task"
        Resource = "arn:aws:states:::sns:publish"
        Arguments = {
          TopicArn = aws_sns_topic.notifications.arn
          Subject  = "Video processed"
          Message  = "{% 'Processed ' & $videoKey & '. Results: s3://' & $bucket & '/' & $out %}"
        }
        End = true
      }

      NotifyFailed = {
        Type     = "Task"
        Resource = "arn:aws:states:::sns:publish"
        Arguments = {
          TopicArn = aws_sns_topic.notifications.arn
          Subject  = "Video processing failed"
          Message  = "{% 'Processing failed for ' & $videoKey & ': ' & $string($states.input) %}"
        }
        Next = "Failed"
      }

      Failed = {
        Type = "Fail"
      }
    }
  }
}

resource "aws_sfn_state_machine" "pipeline" {
  name       = "${local.name}-pipeline"
  role_arn   = aws_iam_role.pipeline.arn
  type       = "STANDARD"
  definition = jsonencode(local.pipeline_definition)
}

data "aws_iam_policy_document" "states_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "pipeline" {
  name               = "${local.name}-pipeline"
  assume_role_policy = data.aws_iam_policy_document.states_assume.json
}

data "aws_iam_policy_document" "pipeline" {
  statement {
    actions   = ["rekognition:StartLabelDetection", "rekognition:GetLabelDetection"]
    resources = ["*"]
  }

  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.videos.arn}/uploads/*"]
  }

  statement {
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.videos.arn}/processed/*"]
  }

  statement {
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.notifications.arn]
  }
}

resource "aws_iam_role_policy" "pipeline" {
  name   = "pipeline"
  role   = aws_iam_role.pipeline.id
  policy = data.aws_iam_policy_document.pipeline.json
}
