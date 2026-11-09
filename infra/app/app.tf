data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "ALB: HTTP from CloudFront only"
  vpc_id      = local.base.vpc_id

  ingress {
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "api" {
  name        = "${local.name}-api"
  description = "API instances: container ports from the ALB only"
  vpc_id      = local.base.vpc_id

  ingress {
    from_port       = 32768
    to_port         = 65535
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_lb" "main" {
  name               = local.name
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = local.base.public_subnet_ids
}

resource "aws_lb_target_group" "api" {
  name        = "${local.name}-api"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = local.base.vpc_id
  target_type = "instance"

  health_check {
    path    = "/healthz"
    matcher = "200"
  }

  deregistration_delay = 10
}

resource "aws_lb_target_group" "web" {
  name        = "${local.name}-web"
  port        = 80
  protocol    = "HTTP"
  vpc_id      = local.base.vpc_id
  target_type = "instance"

  health_check {
    path    = "/"
    matcher = "200"
  }

  deregistration_delay = 10
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10

  condition {
    path_pattern {
      values = ["/api/*", "/healthz"]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

data "aws_ssm_parameter" "ecs_ami" {
  name = "/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id"
}

resource "aws_launch_template" "api" {
  name_prefix            = "${local.name}-api-"
  image_id               = data.aws_ssm_parameter.ecs_ami.value
  instance_type          = var.api_instance_type
  vpc_security_group_ids = [aws_security_group.api.id]

  iam_instance_profile {
    name = local.base.instance_profile
  }

  metadata_options {
    http_tokens = "required"
  }

  user_data = base64encode(<<-EOT
    #!/bin/bash
    set -euxo pipefail
    dnf install -y https://s3.amazonaws.com/mountpoint-s3-release/latest/x86_64/mount-s3.rpm
    echo user_allow_other >> /etc/fuse.conf
    mkdir -p /mnt/videos
    mount-s3 ${local.base.bucket} /mnt/videos --region ${local.base.region} --allow-other --allow-delete --uid 65532 --gid 65532 --dir-mode 0755 --file-mode 0644
    echo ECS_CLUSTER=${local.base.ecs_cluster} >> /etc/ecs/ecs.config
    echo ECS_INSTANCE_ATTRIBUTES='{"role":"api"}' >> /etc/ecs/ecs.config
  EOT
  )

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${local.name}-api" }
  }
}

resource "aws_autoscaling_group" "api" {
  name                = "${local.name}-api"
  min_size            = 1
  max_size            = 1
  desired_capacity    = 1
  vpc_zone_identifier = local.base.public_subnet_ids

  launch_template {
    id      = aws_launch_template.api.id
    version = aws_launch_template.api.latest_version
  }
}

resource "random_password" "jwt" {
  length  = 48
  special = false
}

resource "aws_ssm_parameter" "jwt" {
  name  = "/${local.name}/jwt-secret"
  type  = "SecureString"
  value = random_password.jwt.result
}

resource "aws_iam_role_policy" "execution_ssm" {
  name = "read-app-secrets"
  role = split("/", local.base.task_execution_role_arn)[1]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "ssm:GetParameters"
      Resource = aws_ssm_parameter.jwt.arn
    }]
  })
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api_task" {
  name               = "${local.name}-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "api_task_db" {
  name = "connect-aurora"
  role = aws_iam_role.api_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "rds-db:connect"
      Resource = "arn:aws:rds-db:${local.base.region}:${data.aws_caller_identity.current.account_id}:dbuser:${local.base.db_resource_id}/api"
    }]
  })
}

resource "aws_cloudwatch_log_group" "app" {
  for_each          = toset(["api", "web"])
  name              = "/ecs/${local.name}-${each.key}"
  retention_in_days = 7
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["EC2"]
  network_mode             = "bridge"
  execution_role_arn       = local.base.task_execution_role_arn
  task_role_arn            = aws_iam_role.api_task.arn

  volume {
    name      = "videos"
    host_path = "/mnt/videos"
  }

  container_definitions = jsonencode([{
    name         = "api"
    image        = "${local.base.api_repository}:${var.image_tag}"
    essential    = true
    memory       = 512
    portMappings = [{ containerPort = 8080, hostPort = 0 }]
    environment = [
      { name = "DB_IAM_HOST", value = local.base.db_host },
      { name = "DB_USER", value = "api" },
      { name = "DB_NAME", value = "videointell" },
      { name = "AWS_REGION", value = local.base.region },
      { name = "LOCAL_DATA_DIR", value = "/mnt/videos" },
      { name = "REQUIRE_MOUNT", value = "true" },
      { name = "COGNITO_USER_POOL_ID", value = local.base.cognito_user_pool_id },
      { name = "COGNITO_CLIENT_ID", value = local.base.cognito_client_id },
    ]
    secrets     = [{ name = "JWT_SECRET", valueFrom = aws_ssm_parameter.jwt.arn }]
    mountPoints = [{ sourceVolume = "videos", containerPath = "/mnt/videos" }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app["api"].name
        awslogs-region        = local.base.region
        awslogs-stream-prefix = "api"
      }
    }
  }])
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${local.name}-web"
  requires_compatibilities = ["EC2"]
  network_mode             = "bridge"
  execution_role_arn       = local.base.task_execution_role_arn

  container_definitions = jsonencode([{
    name         = "web"
    image        = "${local.base.web_repository}:${var.image_tag}"
    essential    = true
    memory       = 128
    portMappings = [{ containerPort = 80, hostPort = 0 }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app["web"].name
        awslogs-region        = local.base.region
        awslogs-stream-prefix = "web"
      }
    }
  }])
}

resource "aws_ecs_service" "app" {
  for_each = {
    api = { task = aws_ecs_task_definition.api.arn, tg = aws_lb_target_group.api.arn, port = 8080 }
    web = { task = aws_ecs_task_definition.web.arn, tg = aws_lb_target_group.web.arn, port = 80 }
  }

  name                               = each.key
  cluster                            = local.base.ecs_cluster
  task_definition                    = each.value.task
  desired_count                      = 1
  launch_type                        = "EC2"
  deployment_minimum_healthy_percent = 0
  health_check_grace_period_seconds  = 60

  placement_constraints {
    type       = "memberOf"
    expression = "attribute:role == api"
  }

  load_balancer {
    target_group_arn = each.value.tg
    container_name   = each.key
    container_port   = each.value.port
  }

  depends_on = [aws_lb_listener_rule.api, aws_iam_role_policy.execution_ssm]
}
