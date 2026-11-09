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

output "vpc_id" {
  value = aws_vpc.main.id
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "ecs_cluster" {
  value = aws_ecs_cluster.main.name
}

output "instance_profile" {
  value = aws_iam_instance_profile.worker.name
}

output "task_execution_role_arn" {
  value = aws_iam_role.task_execution.arn
}

output "db_host" {
  value = aws_rds_cluster.db.endpoint
}

output "db_resource_id" {
  value = aws_rds_cluster.db.cluster_resource_id
}

output "region" {
  value = var.region
}

output "api_repository" {
  value = aws_ecr_repository.app["api"].repository_url
}

output "web_repository" {
  value = aws_ecr_repository.app["web"].repository_url
}

output "app_url" {
  value = one([for d in aws_cloudfront_distribution.app : "https://${d.domain_name}"])
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.web.id
}

output "cognito_domain" {
  value = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.region}.amazoncognito.com"
}

output "bedrock_profile_id" {
  value = var.bedrock_profile
}

output "bedrock_profile_arn" {
  value = local.bedrock_profile_arn
}

output "bedrock_model_arn" {
  value = local.bedrock_model_arn
}
