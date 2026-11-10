variable "cloudfront_enabled" {
  type    = bool
  default = false
}

data "terraform_remote_state" "app" {
  backend = "local"
  config = {
    path = "${path.module}/app/terraform.tfstate"
  }
  defaults = {
    alb_dns = "app-not-running.example.com"
  }
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewer"
}

resource "random_password" "origin_secret" {
  length  = 40
  special = false
}

resource "aws_cloudfront_distribution" "app" {
  count           = var.cloudfront_enabled ? 1 : 0
  enabled         = true
  comment         = "${local.name} app"
  price_class     = "PriceClass_200"
  is_ipv6_enabled = true
  web_acl_id      = local.waf_on ? aws_wafv2_web_acl.app[0].arn : null

  origin {
    origin_id   = "alb"
    domain_name = data.terraform_remote_state.app.outputs.alb_dns

    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin_secret.result
    }

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      origin_read_timeout    = 60
    }
  }

  default_cache_behavior {
    target_origin_id         = "alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
    compress                 = true
  }

  ordered_cache_behavior {
    path_pattern           = "/assets/*"
    target_origin_id       = "alb"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = data.aws_cloudfront_cache_policy.optimized.id
    compress               = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
