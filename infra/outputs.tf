output "bucket" {
  value = aws_s3_bucket.videos.id
}

output "event_rule" {
  value = aws_cloudwatch_event_rule.video_uploaded.name
}

output "event_log_group" {
  value = aws_cloudwatch_log_group.video_uploaded.name
}
