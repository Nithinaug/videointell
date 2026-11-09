# Video Intelligence & Processing Platform

> **Build it yourself:** [docs/walkthrough.md](docs/walkthrough.md) explains every
> AWS piece, with Console click-paths and the matching Terraform.

## Problem statement

Organizations and individuals generate large amounts of video content
(meetings, lectures, interviews, training sessions, webinars, tutorials) that
is hard to manage, search, and consume. Users have to watch an entire video
to find specific information, and manually create transcripts and summaries.
Transcoding, transcription and summarising are CPU-heavy, so running them on
the server that answers web requests starves the app when many users upload
at once. That processing has to run somewhere else.

## Why serverful and no SDK

This is a learning project and the serverful twin of my serverless project,
ClimaRoute. Two rules shape every choice below:

- **Serverful:** every piece of compute that runs our code is an EC2 instance
  we size and patch, with ECS placing containers on it.
- **No AWS SDK in our code:** all AWS wiring lives in Terraform, so the
  infrastructure is the thing being learned. Our code makes no AWS API calls;
  AWS services, the Mountpoint client and the ECS agent make them for us. The
  only AWS endpoint our code talks to is a public HTTPS key download (see
  [Identity and playback](#identity-and-playback)).

A third constraint: the AWS account is on the **AWS Free plan**, which blocks
MediaConvert and Transcribe (`SubscriptionRequiredException`). Transcoding
and transcription therefore run in our own Lambda workers with ffmpeg and
whisper.cpp; Rekognition, Step Functions, SNS and EventBridge work on the
plan.

Some code exists only because of the no-SDK rule: HMAC-signed file URLs,
CloudFront cookie signing with Go's standard crypto, and the Mountpoint
folder. That is deliberate, not accidental complexity.

## Target design

> **Not built yet.** This section describes where the project is going. The
> [Status](#status) list shows what exists today.

- **ECS on EC2** runs the Go API and an Nginx server for the React build on
  one Auto Scaling group.
- **Lambda fan-out** does the heavy work: Step Functions splits each video
  into 30-second chunks and a Distributed Map runs one Lambda per chunk
  (ffmpeg + whisper.cpp, up to 1,000 at once), so a long video takes about
  as long as a short one and processing never takes CPU from the API.
- **CloudFront + WAF + Application Load Balancer** is the public entry point.
  Users sign in with **Amazon Cognito** managed login (OAuth code flow with
  PKCE in the browser); the API checks Cognito's ID token itself.
- **Mountpoint for Amazon S3** mounts the video bucket on each EC2 host, so
  the API saves uploads as plain files and they land in S3.
- **EventBridge + Step Functions** turn each finished upload into a pipeline:
  **Lambda** workers (split, then HLS, thumbnails and transcript per chunk,
  then stitch), **Rekognition Video** (labels, in parallel), **Bedrock** (summary, chapters, tags), then
  the result into **Aurora PostgreSQL** through the **RDS Data API**, and an
  **SNS** email.
- **Aurora PostgreSQL Serverless v2** (express configuration, 0 to 4 ACU,
  pauses after 5 minutes idle) stores users, videos, status and results.
  Aurora is required, not plain RDS, because Step Functions writes to it
  through the RDS Data API. On the Free plan only express clusters are
  allowed: no VPC, reached through Aurora's internet access gateway, IAM
  sign-in only. The API signs its IAM sign-in token with Go stdlib.
- **CloudFront** serves the processed video from S3 through Origin Access
  Control, protected by signed cookies.

Everything runs in a VPC with instances in private subnets, no SSH (Systems
Manager Session Manager instead), Secrets Manager for credentials and
CloudWatch for logs, metrics and alarms.

### Serverless vs serverful

The same kinds of jobs as ClimaRoute, done the serverful way:

| Job | ClimaRoute (serverless) | This project (serverful) |
|---|---|---|
| API compute | Lambda (container images) | Go API container on EC2 (ECS, EC2 launch type) |
| Public entry, throttling | API Gateway HTTP API | CloudFront + ALB + AWS WAF rate rule |
| Auth | Cognito in the app | Cognito managed login in the app (PKCE); the API verifies the ID token |
| Heavy work | Step Functions Distributed Map on Lambda | The same: Distributed Map of Go Lambda workers (ffmpeg, whisper.cpp), plus Rekognition and Bedrock |
| Long-running jobs | ECS Fargate | ECS on an EC2 Auto Scaling group |
| Database | DynamoDB (TTL expiry) | Aurora PostgreSQL (provisioned) |
| Frontend hosting | Amplify Hosting | Nginx container behind the ALB, cached by CloudFront |
| Scaling | Per request, automatic | API: fixed Auto Scaling group; processing: Lambda concurrency |
| Shared | S3, ECR, CloudWatch, Budgets | S3, ECR, CloudWatch (+ agent), Budgets |

### Request path

```text
                    USERS (browser)
                          |
                          v
                     +----------+
                     | Route 53 |
                     +----+-----+
                          |
                          v
               +---------------------+
               | CloudFront  (+ WAF) |------------------------------+
               +----------+----------+   /media/* (signed cookie)   |
                          |                                         |
                          v                                         |
               +---------------------+    sign-in    +---------+    |
               |  Application Load   | <-----------> | Cognito |    |
               |  Balancer (accepts  |               +---------+    |
               |  CloudFront only)   |                              |
               +-----+---------+-----+                              |
              /api/* |         | /*                                 |
                     v         v                                    |
               +----------+ +----------+                            |
               | API (Go) | |  Nginx   |                            |
               |  no SDK  | | (React)  |                            |
               +--+----+--+ +----------+                            |
                  |    |                                            v
       SQL        |    | writes file + .done marker        +----------------+
                  v    v   to /mnt/videos                  | S3 processed/  |
          +-----------+  +------------------------+        +----------------+
          |  Aurora   |  | Mountpoint for S3      | -----> +----------------+
          | Postgres  |  | (on the EC2 host)      |        | S3 uploads/    |
          +-----------+  +------------------------+        +----------------+
```

### Processing path

```text
   +---------------+  Object Created   +-------------+
   | S3 uploads/   | ----------------> | EventBridge |  matches uploads/*.done only
   |  <key>.done   |                   +------+------+
   +---------------+                          |
                                              v
                               +-----------------------------+
                               |  Step Functions (Standard)  |
                               +--------------+--------------+
                                              |
        0. set_video_status(key, [uploaded] -> processing); stop if false
                                              |
        1. Parallel:
           a. Lambda split: ffmpeg copies the upload into ~30 s chunks
              (cut at keyframes, no re-encode) under work/
              Distributed Map, one Lambda per chunk (up to 1,000 at once):
              HLS ladder capped at source resolution, thumbnails every 10 s,
              whisper.cpp transcript shifted to the chunk's start
              Lambda assemble: joins the playlists (DISCONTINUITY between
              chunks) and transcripts, writes VTT and the Bedrock request
           b. Rekognition Video on the upload: Start, then Wait/Get loop
              -> labels.json in S3
                                              |
        3. Bedrock InvokeModel with S3 input and output -> summary, chapters, tags
                                              |
        5. set_video_status(key, [processing] -> ready, results)
                                              |
        6. SNS -> "video ready" email

   Every task: Retry with backoff on throttling errors.
   Any other failure: Catch -> set_video_status(key, [processing] -> failed) -> SNS alert
```

### Video processing workflow

1. The user signs in on Cognito's managed login page and comes back with an
   ID token.
2. The browser calls `POST /api/videos`. The API inserts a video row with
   status `uploading` and returns a signed upload URL.
3. The browser PUTs the file to `/api/files/...`. The API writes it to
   `/mnt/videos/uploads/...` (Mountpoint), so it lands in S3 `uploads/`.
4. Only after the file is fully written, the API sets the status to
   `uploaded` and writes an empty `<key>.done` marker next to it. A failed or
   cut-off upload never gets a marker, so it never starts the pipeline.
5. The marker's Object Created event matches the EventBridge rule
   `uploads/*.done`, which starts the state machine with the marker's key.
   The state machine strips `.done` to get the video key.
6. The state machine runs the steps in the processing path above. Large data
   (video files, transcripts, labels, Bedrock input and output) stays in S3;
   only S3 keys pass through the state, which keeps it under the 256 KB
   limit.
7. The dashboard reads the status from Aurora, and while a video is being
   processed the video page polls `GET /api/videos/:id/progress` (split done,
   chunks done out of total, labels, stitch, summary), worked out from marker
   files the Lambdas write. Once `ready`, the player streams the HLS files
   from `processed/` through a signed results-folder URL.

### Video status

One Postgres function owns every status change:
`set_video_status(original_key, from_statuses, to_status, results)`. It
changes the row only if the current status is in `from_statuses` and returns
whether it did. The API calls it through the Postgres driver; the state
machine calls `SELECT set_video_status(...)` through the RDS Data API. The
function and a unique index on `original_key` live in the API's migrations,
so the schema has one owner.

```text
uploading --(API, upload written)--> uploaded --(pipeline start)--> processing --> ready
                                                                           \----> failed
```

A duplicate EventBridge event, a late write or a stray `.done` file for an
unknown key changes nothing.

### Identity and playback

- **Sign-in:** the React app sends the user to Cognito's managed login page
  (OAuth authorization code flow with PKCE, made with the browser's Web
  Crypto) and swaps the code for tokens at Cognito's token endpoint. It
  sends the ID token as a bearer token. The API checks the RS256 signature
  against Cognito's public keys (downloaded over HTTPS, not an SDK call),
  the issuer, the audience (the app client), `token_use = id` and expiry,
  then finds or creates the user row by email. Why not the ALB's
  `authenticate-cognito`: it needs an HTTPS listener, which needs a domain
  the project does not own.
- **No bypass:** the ALB security group accepts traffic only from the
  CloudFront origin-facing prefix list, so requests cannot skip WAF.
- **Uploads:** `PUT /api/files/...` with an HMAC-signed, 15-minute URL, on
  AWS and locally.
- **Playback:** `GET /api/results/<exp>/<sig>/processed/<user>/<file>/...`.
  The signature covers one video's results folder for one hour and sits in
  the path, so the HLS playlists' relative links to segments keep working.
  The API serves the files through Mountpoint. CloudFront signed cookies
  could replace this later.
- **Original upload:** `GET /api/files/...` with an HMAC-signed URL, used
  while a video is still processing.
- **Search:** `GET /api/search?q=` reads the user's ready transcripts and
  returns up to 50 lines that contain every word, each with its video and
  start time; the app opens the video at that second (`?t=`).
- **Delete:** `DELETE /api/videos/:id` removes the upload, its marker, the
  results and the work chunks through Mountpoint, then the database row.
  It refuses while a video is queued or processing, because the pipeline
  would write files back after the delete.

### Network architecture

```text
                         VPC
                          |
          +---------------+----------------+
          |                                |
   Availability Zone A              Availability Zone B
          |                                |
   Public Subnet: ALB, NAT          Public Subnet: ALB
   Private Subnet: EC2 (ECS)        Private Subnet: EC2 (ECS)
   (Aurora express cluster sits outside the VPC, reached over TLS with IAM tokens)
```

**Built so far:** two public subnets, an internet gateway and an S3 gateway
endpoint, with no NAT Gateway. The API instance has a public IP (for ECR
pulls and the Aurora gateway) and its security group only accepts the ALB.
Lambda workers run outside the VPC.

Traffic path: `Internet -> CloudFront -> ALB -> EC2 (ECS task) -> Aurora`.
Instances have no public IPs and no SSH port; a shell comes through Session
Manager. Outbound traffic (ECR pulls) goes through one NAT Gateway; an S3
gateway endpoint keeps the large video transfers off the NAT, which bills
per GB.

### Scaling

- **API tasks**: ECS target tracking on average CPU at 60%.
- **Processing**: one Lambda per 30-second chunk, capped by the Map's
  `MaxConcurrency` (1,000) and the account's Lambda concurrency (1,000 in
  ap-south-1). Measured: the test clip took 58 s end to end, against about
  220 s with the old EC2 worker starting cold.
- **Managed calls**: Rekognition and Bedrock quotas are the limit; every
  call retries with backoff.

### Alternatives considered

| Choice | Picked | Rejected and why |
|---|---|---|
| Upload path | Through the API to Mountpoint | Presigned PUT straight to S3: needs request signing, which means the SDK or hand-written SigV4. CloudFront OAC PUT: needs per-part signing for big files, loses the no-overwrite guard, and splits local dev from AWS. |
| Transcoding and transcription | Lambda fan-out (Distributed Map) with ffmpeg and whisper.cpp in a container image | MediaConvert and Transcribe: blocked on the AWS Free plan. EC2 worker on its own Auto Scaling group (built first): about 3.5 min cold start per video and one video per instance. Fargate: no Mountpoint, and no faster than a warm pool. |
| Transcript to Bedrock | The assemble Lambda writes the request body | Doing it inside the state machine: a long transcript passes the 256 KB state limit. |
| Status updates | One Postgres function, called by both API and pipeline | Pipeline writes a results file that the API reads back: a lagging dashboard and extra read code. |

### Known limits

- **Uploads pass through the API hosts.** That is network work, not the CPU
  work the problem statement is about. A very slow upload can hit the
  CloudFront or ALB timeout, and scale-in can cut off an upload in progress.
- **No NAT Gateway.** The API instance sits in a public subnet with a
  public IP and a security group that accepts only the ALB. Accepted for
  cost while the project is a demo.
- **Max video:** 5 GiB per upload, and about 4.5 GiB in practice: the split
  Lambda keeps the upload and its chunks in its 10 GB `/tmp`.
- **Chunk edges:** whisper hears each 30-second chunk on its own, so a word
  cut at an edge can come out wrong.
- **Labels:** Rekognition reads only MP4 and MOV (H.264). Other formats
  (for example WebM) get an empty label list; the rest of the pipeline runs.
- **Search scale:** search reads every ready transcript per query. Fine for
  tens of videos; for hundreds, move to Postgres full-text search filled
  when the pipeline marks a video ready.
- **Speech model:** whisper.cpp `base` is fast but weak on strong accents
  and Hindi; a larger model would cost more Lambda time per chunk.
- **Bedrock on the Free plan:** Claude models are sold through AWS
  Marketplace and fail without a payment method, so the summary uses
  Amazon Nova Lite (`apac.amazon.nova-lite-v1:0`).
- **Retention:** the `expire-test-uploads` rule deletes `uploads/` after
  3 days. That is a test setting. Playback after `ready` comes from
  `processed/`, so expiry only blocks re-processing an old video.
- **Cost:** EC2, the NAT Gateway, the ALB and Aurora bill by the hour even
  when idle. Tear the stack down after demos.
- **Region:** `ap-south-1`. Rekognition Video and Nova Lite work there
  (checked).

### Later

- Postgres full-text search over transcripts, summaries and tags, when
  libraries outgrow file scanning.
- Labels for non-MP4 uploads: remux the 480p chunks into an MP4 for
  Rekognition.
- Moderation flags in the UI.
- An Aurora reader in AZ B, customer-managed KMS keys, Container Insights.

### AWS services in scope

| Category | Services |
|---|---|
| Compute | Lambda (container image, 10 GB memory and /tmp), EC2, Launch Templates, Auto Scaling group, ECS (EC2 launch type), ECR, EBS gp3 |
| Networking & delivery | VPC, Subnets, Route Tables, Internet Gateway, NAT Gateway, S3 gateway endpoint, Security Groups, Application Load Balancer, CloudFront, Route 53, ACM |
| Storage & database | S3 (SSE-S3 encryption, lifecycle expiry on uploads/), Mountpoint for S3, Aurora PostgreSQL with the RDS Data API |
| Orchestration | EventBridge, Step Functions (Standard) |
| Media & AI | Rekognition Video, Amazon Bedrock (ffmpeg and whisper.cpp run in our Lambda workers) |
| Notifications | SNS |
| Security | Cognito, IAM roles (instance, task, state machine), Secrets Manager, Systems Manager Session Manager, AWS WAF, CloudTrail |
| Monitoring & cost | CloudWatch Logs, metrics, alarms, CloudWatch agent, AWS Budgets |

## Infrastructure as code

Each service is learned in the **AWS Console** first, then written in
**Terraform**, so the stack can come up with `terraform apply` and go away
with `terraform destroy`. That matters in a serverful stack: EC2, the NAT
Gateway, the ALB and Aurora bill by the hour whether anyone uses them or not.
The video bucket has `prevent_destroy`, so `terraform destroy` stops at it
instead of deleting it.

**Terraform:**
- Network: VPC, subnets, NAT, S3 endpoint, security groups, ALB,
  CloudFront, WAF, ACM, Route 53 records
- Compute: worker Lambda (container image), API launch template (installs
  Mountpoint) and Auto Scaling group, ECS cluster, task definitions,
  services, ECR
- Data: Aurora, S3 bucket (lifecycle, encryption, EventBridge notifications)
- Pipeline: EventBridge rule, Step Functions state machine, SNS topic
- Security and ops: Cognito user pool, IAM roles, Secrets Manager secrets,
  CloudTrail, CloudWatch log groups and alarms

**Console (one-time):** Terraform state bucket, AWS Budget alert, Bedrock
model access, SNS email confirmation, first Cognito user.

**Other tools:** `docker build` and push to ECR; the AWS CLI for manual
checks such as reading a state machine run.

### Who makes each AWS call

| AWS call | Made by | Set up in |
|---|---|---|
| Save upload to S3 | Mountpoint for S3 on the EC2 host | Launch template user data |
| Start the pipeline | S3 -> EventBridge rule on `uploads/*.done` | Terraform |
| Rekognition, Bedrock, S3 writes of small results | Step Functions service integrations | State machine definition |
| Run the workers | Step Functions `lambda:invoke` and a Distributed Map | State machine definition |
| Worker S3 reads and writes | AWS SDK for Go v2, in the Lambda code only | `cmd/worker` |
| Update video status | Step Functions -> RDS Data API -> `set_video_status` | State machine definition |
| Send email | Step Functions -> SNS | State machine definition |
| Read secrets | ECS injects Secrets Manager values as env vars | Task definition |
| Sign-in | Cognito managed login, OAuth code flow with PKCE | React app (`src/auth.ts`) |
| Check who the user is | API downloads Cognito's JWKS over HTTPS (not an SDK call) | API middleware (`internal/cognito`) |
| Private playback | CloudFront checks the signed cookie | CloudFront key group |

No SDK, CDK or SAM is used in this repository.

## Status

Done:
- [x] Go API, Postgres, React frontend
- [x] Uploads and playback through local storage with HMAC-signed URLs
- [x] AWS SDK removed: the API only writes and reads files (designed for the
      Mountpoint folder on AWS, not yet tested there)
- [x] Upload handler sets `uploaded` and writes the `.done` marker;
      `set_video_status` function added; `/complete` removed
- [x] Terraform: S3 bucket (imported from the Console, `prevent_destroy`),
      EventBridge rule on `uploads/*.done` logging to CloudWatch Logs until
      Step Functions is the target

- [x] Upload filenames cleaned to `[A-Za-z0-9._-]`, so S3 keys never need
      URL encoding in events
- [x] Terraform: SNS topic and a first Step Functions pipeline (Rekognition
      labels on the upload, `labels.json` to S3, SNS email; Retry on
      throttling, failure alert), started by the EventBridge rule

- [x] Go worker (`cmd/worker`): ffmpeg HLS ladder capped at the source
      height, thumbnails, H.264 MP4, whisper.cpp transcript, Bedrock request
      body; tested end to end with ffmpeg and a stand-in whisper script

- [x] Dockerfiles for the API (distroless), the worker (ffmpeg, whisper.cpp
      v1.9.5 with the `base` model) and Nginx; worker image run locally with
      real whisper.cpp
- [x] Terraform for the AWS worker: ECR repository, VPC with public subnets
      and S3 endpoint, ECS cluster, worker Auto Scaling group (0 to 1
      `c7i-flex.large`, Free plan eligible) with Mountpoint in the launch
      template, capacity provider, task definition; the pipeline runs the
      worker before Rekognition

- [x] Worker image pushed; pipeline run on AWS end to end (`.done` marker ->
      worker on a fresh instance -> Rekognition -> `labels.json`): about
      3.5 min from a cold start, about 40 s when an instance is already up
- [x] Bedrock step: Nova Lite reads the worker's request from S3 and
      `summary.json` (summary, chapters, tags) is saved; run on AWS end to end
- [x] Results page: HLS player with poster and captions, summary, chapters
      that follow playback, tags, labels; files served through one signed
      results-folder URL (`/api/results/<exp>/<sig>/processed/...`)

To do, in build order:
- [x] Aurora Serverless v2 (express, created in the Console and imported into
      Terraform), Data API with a `pipeline` user in Secrets Manager; the
      pipeline claims the video (`uploaded -> processing`, stops if not
      claimed), then sets `ready` with results or `failed`; run on AWS
- [x] App stack (`infra/app/`, torn down on its own): ALB, API Auto Scaling
      group (1 `t3.small`, Mountpoint), API and Nginx on ECS; the API signs
      Aurora IAM tokens with stdlib SigV4; secrets in SSM Parameter Store
- [x] Processing moved from the EC2 worker to Lambda fan-out: split into
      30 s chunks, Distributed Map (up to 1,000 Lambdas), assemble;
      Rekognition runs on the upload in parallel; 58 s for the test clip
- [x] Cognito user pool (Essentials tier, managed login v2, branding edited
      in the Console), PKCE sign-in in the app, API verifies ID tokens;
      password login removed; tested locally against the real pool
- [ ] CloudFront in front of the ALB (written, behind `cloudfront_enabled`;
      waiting for AWS to verify the account for CloudFront)
- [x] Operations: AWS Budget on gross usage (credits excluded, $25 a month,
      alerts at 80% actual and 100% forecast), multi-Region CloudTrail into
      its own bucket (30-day expiry), CloudWatch alarms (pipeline failed,
      worker Lambda errors and throttles, API 5xx), all to the SNS topic
- [x] App: Aurora glass redesign (Motion), live pipeline tracker, delete
      (S3 and Aurora), transcript panel with click to seek, search across
      transcripts that opens the video at the moment
- [ ] WAF on CloudFront (after CloudFront)

## How this is being built

- **Frontend**: React + TypeScript + Vite + Tailwind
- **Backend**: Go (Gin) API, Postgres, no AWS SDK (signs its Aurora IAM
  token with stdlib SigV4)
- **Workers**: one `cmd/worker` Lambda image with ffmpeg and whisper.cpp and
  three operations (`split`, `chunk`, `assemble`). Lambda cannot use
  Mountpoint, so this is the one place the AWS SDK is used (S3 get and put)
- **Infrastructure**: AWS Console to learn each service, then Terraform

## Project layout

```
backend/
  cmd/server/         API server entrypoint
  cmd/worker/         Lambda entrypoint (split, chunk, assemble; S3 via SDK)
  internal/worker/    ffmpeg, whisper.cpp, playlist and transcript stitching
  internal/config/    env-based configuration
  internal/db/        Postgres connection + embedded SQL migrations
  internal/models/    shared data types
  internal/store/     SQL queries
  internal/cognito/   Cognito ID token check (RS256 against the pool's JWKS)
  internal/storage/   file storage (local folder, or the Mountpoint for S3 folder on AWS)
  internal/handlers/  HTTP handlers
  internal/router/    route wiring
frontend/
  src/api/            typed API client
  src/context/        auth context
  src/pages/          Login, Register, Dashboard, Upload, VideoDetail
  src/components/     shared UI pieces
infra/
  Terraform (in progress)
```

## Running locally

Requires Go 1.26+, Node 20+, Docker (for Postgres), and the base
Terraform stack applied once (for the Cognito user pool).

```bash
# Postgres
docker run -d --name videointell-pg -p 5432:5432 \
  -e POSTGRES_USER=videointell -e POSTGRES_PASSWORD=videointell -e POSTGRES_DB=videointell \
  postgres:16-alpine

# Backend
cd backend
COGNITO_USER_POOL_ID="$(terraform -chdir=../infra output -raw cognito_user_pool_id)" \
COGNITO_CLIENT_ID="$(terraform -chdir=../infra output -raw cognito_client_id)" \
go run ./cmd/server

# Frontend
cd frontend
npm install
VITE_COGNITO_DOMAIN="$(terraform -chdir=../infra output -raw cognito_domain)" \
VITE_COGNITO_CLIENT_ID="$(terraform -chdir=../infra output -raw cognito_client_id)" \
npm run dev
```

Open `http://localhost:5173` and sign up on the Cognito page. Uploads are
saved under `backend/data/`, which the pipeline never sees.

**Hybrid mode (local app, real pipeline):** mount the bucket with
Mountpoint for S3 and point the API at it and at Aurora. Uploads then land
in S3 and the Lambda pipeline processes them:

```bash
mount-s3 <bucket> ~/mnt/videos --region ap-south-1 --allow-delete
cd backend && eval "$(aws configure export-credentials --format env)" && \
  DB_IAM_HOST=<cluster endpoint> LOCAL_DATA_DIR=$HOME/mnt/videos REQUIRE_MOUNT=true \
  COGNITO_USER_POOL_ID=... COGNITO_CLIENT_ID=... go run ./cmd/server
```

## Environment variables

### Backend

Read from the process environment (`.env` files are not loaded automatically).
Every variable has a local-dev default.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | API listen port |
| `DATABASE_URL` | `postgres://videointell:videointell@localhost:5432/videointell?sslmode=disable` | Postgres connection string; on AWS built from the Secrets Manager value ECS injects |
| `JWT_SECRET` | `dev-secret-change-me` | Signs the short-lived `/api/files/...` and `/api/results/...` URLs (HMAC-SHA256); outside local dev, use at least 32 random bytes |
| `COGNITO_USER_POOL_ID` | _(required)_ | `terraform -chdir=infra output -raw cognito_user_pool_id` |
| `COGNITO_CLIENT_ID` | _(required)_ | `terraform -chdir=infra output -raw cognito_client_id` |
| `LOCAL_DATA_DIR` | `./data` | Video folder; `/mnt/videos` (Mountpoint for S3) on AWS |
| `REQUIRE_MOUNT` | _(empty)_ | Set to `true` on AWS: the API refuses to start if `LOCAL_DATA_DIR` is not a mount point, so uploads never land on the instance disk by mistake |
| `DB_IAM_HOST` | _(empty)_ | Aurora endpoint; when set, the API connects with an IAM token it signs itself instead of `DATABASE_URL` |
| `DB_USER` | `api` | Database user for IAM sign-in |
| `DB_NAME` | `videointell` | Database name for IAM sign-in |
| `AWS_REGION` | `ap-south-1` | Region for the IAM token and the Cognito issuer |

### Worker

Build and push the Lambda image, then `terraform apply` (the function is
pinned to the image digest):

```bash
REPO=$(terraform -chdir=infra output -raw worker_repository)
aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin ${REPO%%/*}
docker build --provenance=false -t $REPO:latest -f backend/Dockerfile.worker backend && docker push $REPO:latest
```

| Variable | Default | Description |
|---|---|---|
| `WHISPER_MODEL` | `/models/whisper.bin` in the image | whisper.cpp model file |
| `CHUNK_SECONDS` | `30` (Terraform `chunk_seconds`) | Chunk length for the fan-out |

Terraform variables: `max_chunk_workers` (Map concurrency, 1000),
`worker_memory_mb` (10240; use 3008 if the account caps Lambda memory).
`go test ./internal/worker/` runs split, chunk and assemble locally with a
folder in place of S3.

### Frontend

Put these in `frontend/.env` (git-ignored; Vite loads it automatically).

| Variable | Default | Description |
|---|---|---|
| `VITE_API_BASE_URL` | `http://localhost:8080` | Backend API base URL; empty behind CloudFront (same origin) |
| `VITE_COGNITO_DOMAIN` | _(required)_ | `terraform -chdir=infra output -raw cognito_domain` |
| `VITE_COGNITO_CLIENT_ID` | _(required)_ | `terraform -chdir=infra output -raw cognito_client_id` |
