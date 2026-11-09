variable "bedrock_profile" {
  type    = string
  default = "apac.amazon.nova-lite-v1:0"
}

locals {
  bedrock_profile_arn = "arn:aws:bedrock:${var.region}:${data.aws_caller_identity.current.account_id}:inference-profile/${var.bedrock_profile}"
  bedrock_model_id    = replace(var.bedrock_profile, "/^[a-z]+\\./", "")

  throttling_errors = [
    "Bedrock.ThrottlingException",
    "Bedrock.ServiceUnavailableException",
    "Bedrock.ModelNotReadyException",
    "Rekognition.LimitExceededException",
    "Rekognition.ProvisionedThroughputExceededException",
    "Rekognition.ThrottlingException",
    "S3.SlowDownException",
    "RdsData.DatabaseResumingException",
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
    Next        = "MarkFailed"
  }]

  db = {
    ResourceArn = aws_rds_cluster.db.arn
    SecretArn   = aws_secretsmanager_secret.pipeline_db.arn
    Database    = "videointell"
  }

  key_param = { Name = "key", Value = { StringValue = "{% $videoKey %}" } }

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
        Next = "MarkProcessing"
      }

      MarkProcessing = {
        Type     = "Task"
        Resource = "arn:aws:states:::aws-sdk:rdsdata:executeStatement"
        Arguments = merge(local.db, {
          Sql        = "SELECT set_video_status(:key, ARRAY['uploaded'], 'processing')"
          Parameters = [local.key_param]
        })
        Output = "{% $states.result.Records[0][0].BooleanValue %}"
        Retry  = local.retry_throttling
        Catch  = local.catch_all
        Next   = "Claimed"
      }

      Claimed = {
        Type    = "Choice"
        Choices = [{ Condition = "{% $states.input %}", Next = "ProcessVideo" }]
        Default = "AlreadyHandled"
      }

      AlreadyHandled = {
        Type = "Succeed"
      }

      ProcessVideo = {
        Type           = "Task"
        Resource       = "arn:aws:states:::ecs:runTask.sync"
        TimeoutSeconds = 10800
        Arguments = {
          Cluster        = aws_ecs_cluster.main.arn
          TaskDefinition = aws_ecs_task_definition.worker.arn_without_revision
          CapacityProviderStrategy = [{
            CapacityProvider = aws_ecs_capacity_provider.worker.name
            Weight           = 1
          }]
          Overrides = {
            ContainerOverrides = [{
              Name        = "worker"
              Environment = [{ Name = "VIDEO_KEY", Value = "{% $videoKey %}" }]
            }]
          }
        }
        Output = "{% {} %}"
        Catch  = local.catch_all
        Next   = "StartLabelDetection"
      }

      StartLabelDetection = {
        Type     = "Task"
        Resource = "arn:aws:states:::aws-sdk:rekognition:startLabelDetection"
        Arguments = {
          Video         = { S3Object = { Bucket = "{% $bucket %}", Name = "{% $out & 'video.mp4' %}" } }
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
          { Condition = "{% $states.input.status = 'FAILED' %}", Next = "MarkFailed" },
        ]
        Default = "WaitForLabels"
      }

      SaveLabels = {
        Type     = "Task"
        Resource = "arn:aws:states:::aws-sdk:s3:putObject"
        Arguments = {
          Bucket      = "{% $bucket %}"
          Key         = "{% $out & 'labels.json' %}"
          Body        = "{% $states.input.labels %}"
          ContentType = "application/json"
        }
        Retry = local.retry_throttling
        Catch = local.catch_all
        Next  = "Summarize"
      }

      Summarize = {
        Type     = "Task"
        Resource = "arn:aws:states:::bedrock:invokeModel"
        Arguments = {
          ModelId     = local.bedrock_profile_arn
          ContentType = "application/json"
          Input       = { S3Uri = "{% 's3://' & $bucket & '/' & $out & 'bedrock-request.json' %}" }
        }
        Output = "{% $parse($replace($trim($states.result.Body.output.message.content[0].text), /^```(json)?\\s*|\\s*```$/, '')) %}"
        Retry  = local.retry_throttling
        Catch  = local.catch_all
        Next   = "SaveSummary"
      }

      SaveSummary = {
        Type     = "Task"
        Resource = "arn:aws:states:::aws-sdk:s3:putObject"
        Arguments = {
          Bucket      = "{% $bucket %}"
          Key         = "{% $out & 'summary.json' %}"
          Body        = "{% $states.input %}"
          ContentType = "application/json"
        }
        Retry = local.retry_throttling
        Catch = local.catch_all
        Next  = "MarkReady"
      }

      MarkReady = {
        Type     = "Task"
        Resource = "arn:aws:states:::aws-sdk:rdsdata:executeStatement"
        Arguments = merge(local.db, {
          Sql = "SELECT set_video_status(:key, ARRAY['processing'], 'ready', :results::jsonb)"
          Parameters = [
            local.key_param,
            { Name = "results", Value = { StringValue = "{% $string({'prefix': $out}) %}" } },
          ]
        })
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

      MarkFailed = {
        Type     = "Task"
        Resource = "arn:aws:states:::aws-sdk:rdsdata:executeStatement"
        Arguments = merge(local.db, {
          Sql        = "SELECT set_video_status(:key, ARRAY['uploaded', 'processing'], 'failed')"
          Parameters = [local.key_param]
        })
        Output = "{% $states.input %}"
        Retry  = local.retry_throttling
        Catch  = [{ ErrorEquals = ["States.ALL"], Next = "NotifyFailed" }]
        Next   = "NotifyFailed"
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
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.videos.arn}/processed/*"]
  }

  statement {
    actions   = ["ecs:RunTask"]
    resources = ["${aws_ecs_task_definition.worker.arn_without_revision}:*"]
  }

  statement {
    actions   = ["ecs:StopTask", "ecs:DescribeTasks"]
    resources = ["*"]
  }

  statement {
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.task_execution.arn]
  }

  statement {
    actions   = ["events:PutTargets", "events:PutRule", "events:DescribeRule"]
    resources = ["arn:aws:events:${var.region}:${data.aws_caller_identity.current.account_id}:rule/StepFunctionsGetEventsForECSTaskRule"]
  }

  statement {
    actions = ["bedrock:InvokeModel"]
    resources = [
      local.bedrock_profile_arn,
      "arn:aws:bedrock:*::foundation-model/${local.bedrock_model_id}",
    ]
  }

  statement {
    actions   = ["rds-data:ExecuteStatement"]
    resources = [aws_rds_cluster.db.arn]
  }

  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.pipeline_db.arn]
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
