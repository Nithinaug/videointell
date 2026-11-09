#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
eval "$(aws configure export-credentials --format env)"
export DB_IAM_HOST="$(terraform -chdir=../infra output -raw db_host)"
export LOCAL_DATA_DIR="$HOME/mnt/videos"
export REQUIRE_MOUNT=true
export COGNITO_USER_POOL_ID="$(terraform -chdir=../infra output -raw cognito_user_pool_id)"
export COGNITO_CLIENT_ID="$(terraform -chdir=../infra output -raw cognito_client_id)"
exec go run ./cmd/server
