variable "worker_instance_type" {
  type    = string
  default = "c7i-flex.large"
}

variable "worker_image_tag" {
  type    = string
  default = "latest"
}

resource "aws_ecs_cluster" "main" {
  name = local.name
}

data "aws_ssm_parameter" "ecs_ami" {
  name = "/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id"
}

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "worker_instance" {
  name               = "${local.name}-worker-instance"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "worker_instance_ecs" {
  role       = aws_iam_role.worker_instance.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
}

resource "aws_iam_role_policy_attachment" "worker_instance_ssm" {
  role       = aws_iam_role.worker_instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "worker_instance_s3" {
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.videos.arn]
  }

  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"]
    resources = ["${aws_s3_bucket.videos.arn}/*"]
  }
}

resource "aws_iam_role_policy" "worker_instance_s3" {
  name   = "mountpoint-s3"
  role   = aws_iam_role.worker_instance.id
  policy = data.aws_iam_policy_document.worker_instance_s3.json
}

resource "aws_iam_instance_profile" "worker" {
  name = "${local.name}-worker"
  role = aws_iam_role.worker_instance.name
}

resource "aws_launch_template" "worker" {
  name_prefix            = "${local.name}-worker-"
  image_id               = data.aws_ssm_parameter.ecs_ami.value
  instance_type          = var.worker_instance_type
  vpc_security_group_ids = [aws_security_group.worker.id]

  iam_instance_profile {
    arn = aws_iam_instance_profile.worker.arn
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
    mount-s3 ${aws_s3_bucket.videos.id} /mnt/videos --region ${var.region} --allow-other --allow-delete --uid 65532 --gid 65532 --dir-mode 0755 --file-mode 0644
    echo ECS_CLUSTER=${aws_ecs_cluster.main.name} >> /etc/ecs/ecs.config
  EOT
  )

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${local.name}-worker" }
  }
}

resource "aws_autoscaling_group" "worker" {
  name                = "${local.name}-worker"
  min_size            = 0
  max_size            = 1
  desired_capacity    = 0
  vpc_zone_identifier = aws_subnet.public[*].id

  launch_template {
    id      = aws_launch_template.worker.id
    version = aws_launch_template.worker.latest_version
  }

  tag {
    key                 = "AmazonECSManaged"
    value               = "true"
    propagate_at_launch = true
  }

  lifecycle {
    ignore_changes = [desired_capacity]
  }
}

resource "aws_ecs_capacity_provider" "worker" {
  name = "${local.name}-worker"

  auto_scaling_group_provider {
    auto_scaling_group_arn         = aws_autoscaling_group.worker.arn
    managed_termination_protection = "DISABLED"

    managed_scaling {
      status          = "ENABLED"
      target_capacity = 100
    }
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = [aws_ecs_capacity_provider.worker.name]
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

resource "aws_iam_role" "task_execution" {
  name               = "${local.name}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${local.name}-worker"
  retention_in_days = 7
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["EC2"]
  network_mode             = "bridge"
  execution_role_arn       = aws_iam_role.task_execution.arn

  volume {
    name      = "videos"
    host_path = "/mnt/videos"
  }

  container_definitions = jsonencode([{
    name      = "worker"
    image     = "${aws_ecr_repository.worker.repository_url}:${var.worker_image_tag}"
    essential = true
    cpu       = 2048
    memory    = 3072
    environment = [
      { name = "LOCAL_DATA_DIR", value = "/mnt/videos" },
      { name = "REQUIRE_MOUNT", value = "true" },
    ]
    mountPoints = [{ sourceVolume = "videos", containerPath = "/mnt/videos" }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.worker.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "worker"
      }
    }
  }])
}
