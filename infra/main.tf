terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "videointell"
      ManagedBy = "terraform"
    }
  }
}

variable "region" {
  type    = string
  default = "ap-south-1"
}

data "aws_caller_identity" "current" {}

locals {
  name   = "videointell"
  bucket = "${local.name}-uploads-${data.aws_caller_identity.current.account_id}-${var.region}-an"
}
