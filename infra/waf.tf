provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = "videointell"
      ManagedBy = "terraform"
    }
  }
}

variable "waf_enabled" {
  type    = bool
  default = false
}

variable "waf_rate_limit" {
  type    = number
  default = 2000
}

locals {
  waf_on = var.cloudfront_enabled && var.waf_enabled
}

resource "aws_wafv2_web_acl" "app" {
  count    = local.waf_on ? 1 : 0
  provider = aws.us_east_1
  name     = "${local.name}-app"
  scope    = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "rate-per-ip"
    priority = 0

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit                 = var.waf_rate_limit
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-per-ip"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "common"
    priority = 1

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"

        scope_down_statement {
          not_statement {
            statement {
              and_statement {
                statement {
                  byte_match_statement {
                    search_string         = "PUT"
                    positional_constraint = "EXACTLY"
                    field_to_match {
                      method {}
                    }
                    text_transformation {
                      priority = 0
                      type     = "NONE"
                    }
                  }
                }
                statement {
                  byte_match_statement {
                    search_string         = "/api/files/"
                    positional_constraint = "STARTS_WITH"
                    field_to_match {
                      uri_path {}
                    }
                    text_transformation {
                      priority = 0
                      type     = "NONE"
                    }
                  }
                }
              }
            }
          }
        }

        rule_action_override {
          name = "SizeRestrictions_BODY"
          action_to_use {
            count {}
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "known-bad-inputs"
    priority = 2

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"

        scope_down_statement {
          not_statement {
            statement {
              and_statement {
                statement {
                  byte_match_statement {
                    search_string         = "PUT"
                    positional_constraint = "EXACTLY"
                    field_to_match {
                      method {}
                    }
                    text_transformation {
                      priority = 0
                      type     = "NONE"
                    }
                  }
                }
                statement {
                  byte_match_statement {
                    search_string         = "/api/files/"
                    positional_constraint = "STARTS_WITH"
                    field_to_match {
                      uri_path {}
                    }
                    text_transformation {
                      priority = 0
                      type     = "NONE"
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name}-app"
    sampled_requests_enabled   = true
  }
}
