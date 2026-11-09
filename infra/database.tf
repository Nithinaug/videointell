import {
  to = aws_rds_cluster.db
  id = "database-1"
}

import {
  to = aws_rds_cluster_instance.db
  id = "database-1-instance-1"
}

resource "aws_rds_cluster" "db" {
  cluster_identifier                  = "database-1"
  engine                              = "aurora-postgresql"
  engine_mode                         = "provisioned"
  master_username                     = "postgres"
  iam_database_authentication_enabled = true
  enable_http_endpoint                = true
  backup_retention_period             = 1
  skip_final_snapshot                 = true

  serverlessv2_scaling_configuration {
    min_capacity             = 0
    max_capacity             = 4
    seconds_until_auto_pause = 300
  }

  lifecycle {
    ignore_changes = [engine_version, engine_lifecycle_support, availability_zones, database_insights_mode]
  }
}

resource "aws_rds_cluster_instance" "db" {
  identifier         = "database-1-instance-1"
  cluster_identifier = aws_rds_cluster.db.id
  instance_class     = "db.serverless"
  promotion_tier     = 1
  engine             = aws_rds_cluster.db.engine

  lifecycle {
    ignore_changes = [engine_version]
  }
}

resource "random_password" "pipeline_db" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "pipeline_db" {
  name                    = "videointell/pipeline-db"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "pipeline_db" {
  secret_id     = aws_secretsmanager_secret.pipeline_db.id
  secret_string = jsonencode({ username = "pipeline", password = random_password.pipeline_db.result })
}
