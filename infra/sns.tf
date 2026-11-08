variable "alert_email" {
  type    = string
  default = null
}

resource "aws_sns_topic" "notifications" {
  name = "${local.name}-notifications"
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alert_email == null ? 0 : 1
  topic_arn = aws_sns_topic.notifications.arn
  protocol  = "email"
  endpoint  = var.alert_email
}
