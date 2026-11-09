resource "aws_cognito_user_pool" "main" {
  name                     = local.name
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  user_pool_tier           = "ESSENTIALS"
  deletion_protection      = "ACTIVE"

  password_policy {
    minimum_length = 12
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
}

resource "aws_cognito_user_pool_domain" "main" {
  domain                = "${local.name}-${data.aws_caller_identity.current.account_id}"
  user_pool_id          = aws_cognito_user_pool.main.id
  managed_login_version = 2
}

resource "aws_cognito_user_pool_client" "web" {
  name                                 = "web"
  user_pool_id                         = aws_cognito_user_pool.main.id
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email"]
  supported_identity_providers         = ["COGNITO"]
  explicit_auth_flows                  = ["ALLOW_REFRESH_TOKEN_AUTH"]
  callback_urls                        = concat([for d in aws_cloudfront_distribution.app : "https://${d.domain_name}/auth/callback"], ["http://localhost:5173/auth/callback"])
  logout_urls                          = concat([for d in aws_cloudfront_distribution.app : "https://${d.domain_name}/"], ["http://localhost:5173/"])
  id_token_validity                    = 60
  access_token_validity                = 60
  token_validity_units {
    id_token     = "minutes"
    access_token = "minutes"
  }
}

resource "aws_cognito_managed_login_branding" "web" {
  user_pool_id                = aws_cognito_user_pool.main.id
  client_id                   = aws_cognito_user_pool_client.web.id
  use_cognito_provided_values = true

  lifecycle {
    ignore_changes = [use_cognito_provided_values, settings, asset]
  }
}
