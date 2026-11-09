terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

data "terraform_remote_state" "base" {
  backend = "local"
  config = {
    path = "${path.module}/../terraform.tfstate"
  }
}

locals {
  name = "videointell"
  base = data.terraform_remote_state.base.outputs
}

provider "aws" {
  region = local.base.region

  default_tags {
    tags = {
      Project   = "videointell"
      ManagedBy = "terraform"
      Stack     = "app"
    }
  }
}

variable "api_instance_type" {
  type    = string
  default = "t3.small"
}

variable "image_tag" {
  type    = string
  default = "latest"
}

data "aws_caller_identity" "current" {}

output "alb_dns" {
  value = aws_lb.main.dns_name
}
