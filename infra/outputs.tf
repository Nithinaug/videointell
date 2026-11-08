output "bucket" {
  value = aws_s3_bucket.videos.id
}

output "event_rule" {
  value = aws_cloudwatch_event_rule.video_uploaded.name
}

output "event_log_group" {
  value = aws_cloudwatch_log_group.video_uploaded.name
}

output "pipeline" {
  value = aws_sfn_state_machine.pipeline.arn
}

output "notifications_topic" {
  value = aws_sns_topic.notifications.arn
}

output "worker_repository" {
  value = aws_ecr_repository.worker.repository_url
}
