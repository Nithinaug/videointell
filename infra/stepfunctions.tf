variable "max_chunk_workers" {
  type    = number
  default = 1000
}

variable "bedrock_profile" {
  type    = string
  default = "apac.amazon.nova-lite-v1:0"
}

locals {
  pipeline_arn        = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${local.name}-pipeline"
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

  retry_lambda = [{
    ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException"]
    IntervalSeconds = 5
    BackoffRate     = 2
    MaxAttempts     = 5
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
        Choices = [{ Condition = "{% $states.input %}", Next = "Process" }]
        Default = "AlreadyHandled"
      }

      AlreadyHandled = {
        Type = "Succeed"
      }

      Process = {
        Type = "Parallel"
        Branches = [
          {
            StartAt = "Split"
            States = {
              Split = {
                Type      = "Task"
                Resource  = "arn:aws:states:::lambda:invoke"
                Arguments = { FunctionName = aws_lambda_function.worker.arn, Payload = { op = "split", bucket = "{% $bucket %}", videoKey = "{% $videoKey %}" } }
                Assign    = { plan = "{% $states.result.Payload %}" }
                Output    = "{% $states.result.Payload.chunks %}"
                Retry     = local.retry_lambda
                Next      = "Chunks"
              }

              Chunks = {
                Type           = "Map"
                Items          = "{% $states.input %}"
                MaxConcurrency = var.max_chunk_workers
                ItemProcessor = {
                  ProcessorConfig = { Mode = "DISTRIBUTED", ExecutionType = "STANDARD" }
                  StartAt         = "Chunk"
                  States = {
                    Chunk = {
                      Type      = "Task"
                      Resource  = "arn:aws:states:::lambda:invoke"
                      Arguments = { FunctionName = aws_lambda_function.worker.arn, Payload = "{% $states.input %}" }
                      Output    = "{% $states.result.Payload %}"
                      Retry     = local.retry_lambda
                      End       = true
                    }
                  }
                }
                Next = "Assemble"
              }

              Assemble = {
                Type      = "Task"
                Resource  = "arn:aws:states:::lambda:invoke"
                Arguments = { FunctionName = aws_lambda_function.worker.arn, Payload = "{% $plan %}" }
                Output    = "{% {} %}"
                Retry     = local.retry_lambda
                End       = true
              }
            }
          },
          {
            StartAt = "StartLabelDetection"
            States = {
              StartLabelDetection = {
                Type     = "Task"
                Resource = "arn:aws:states:::aws-sdk:rekognition:startLabelDetection"
                Arguments = {
                  Video         = { S3Object = { Bucket = "{% $bucket %}", Name = "{% $videoKey %}" } }
                  MinConfidence = 80
                }
                Assign = { labelJob = "{% $states.result.JobId %}" }
                Retry  = local.retry_throttling
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
                Next  = "LabelsDone"
              }

              LabelsDone = {
                Type = "Choice"
                Choices = [
                  { Condition = "{% $states.input.status = 'SUCCEEDED' %}", Next = "SaveLabels" },
                  { Condition = "{% $states.input.status = 'FAILED' %}", Next = "LabelsFailed" },
                ]
                Default = "WaitForLabels"
              }

              LabelsFailed = {
                Type  = "Fail"
                Error = "Rekognition.JobFailed"
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
                End   = true
              }
            }
          },
        ]
        Output = "{% {} %}"
        Catch  = local.catch_all
        Next   = "Summarize"
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
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.videos.arn}/uploads/*"]
  }

  statement {
    actions   = ["states:StartExecution"]
    resources = [local.pipeline_arn]
  }

  statement {
    actions   = ["states:DescribeExecution", "states:StopExecution"]
    resources = ["arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:execution:${local.name}-pipeline/*"]
  }

  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.worker.arn, "${aws_lambda_function.worker.arn}:*"]
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
