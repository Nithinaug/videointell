# Video Intelligence & Processing Platform

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

Some code exists only because of the no-SDK rule: HMAC-signed file URLs,
CloudFront cookie signing with Go's standard crypto, and the Mountpoint
folder. That is deliberate, not accidental complexity.

## Target design

> **Not built yet.** This section describes where the project is going. The
> [Status](#status) list shows what exists today.

- **ECS on an EC2 Auto Scaling group** runs the Go API, an Nginx server for
  the React build, and a small Go worker task used by the pipeline.
- **CloudFront + WAF + Application Load Balancer** is the public entry point.
  The ALB signs users in with **Amazon Cognito**; the API checks the identity
  header the ALB adds.
- **Mountpoint for Amazon S3** mounts the video bucket on each EC2 host, so
  the API saves uploads as plain files and they land in S3.
- **EventBridge + Step Functions** turn each finished upload into a pipeline:
  **MediaConvert**, **Transcribe**, **Rekognition Video**, **Bedrock**, the Go
  worker task, then the result into **Aurora PostgreSQL** through the
  **RDS Data API**, and an **SNS** email.
- **Aurora PostgreSQL** (provisioned instance) stores users, videos, status
  and results; the API reads it with a normal Postgres driver. Aurora is
  required, not plain RDS, because Step Functions writes to it through the
  RDS Data API.
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
| Auth | Cognito in the app | Cognito on the ALB listener |
| Heavy work | Step Functions Distributed Map on Lambda | Step Functions driving MediaConvert, Transcribe, Rekognition and a worker task on EC2 |
| Long-running jobs | ECS Fargate | ECS on an EC2 Auto Scaling group |
| Database | DynamoDB (TTL expiry) | Aurora PostgreSQL (provisioned) |
| Frontend hosting | Amplify Hosting | Nginx container behind the ALB, cached by CloudFront |
| Scaling | Per request, automatic | Target tracking on CPU, capacity provider adds instances |
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
        1. MediaConvert (.sync) -> HLS ladder capped at source resolution,
           thumbnails, watermark, audio rendition, H.264 MP4
                                              |
              +----------------------------------+----------------------------------+
              | 2a. Transcribe on the audio      | 2b. Rekognition Video on the MP4 |
              |     Start, then Wait/Get loop    |     Start, then Wait/Get loop    |
              |     -> transcript JSON in S3     |     -> labels, moderation in S3  |
              +----------------------------------+----------------------------------+
                                              |
        3. ECS RunTask (.sync): Go worker reads the transcript and writes the
           Bedrock request body to S3
                                              |
        4. Bedrock InvokeModel with S3 input and output -> summary, chapters, tags
                                              |
        5. set_video_status(key, [processing] -> ready, results)
                                              |
        6. SNS -> "video ready" email

   Every task: Retry with backoff on throttling errors.
   Any other failure: Catch -> set_video_status(key, [processing] -> failed) -> SNS alert
```

### Video processing workflow

1. The user signs in through Cognito on the ALB.
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
   (transcripts, labels, Bedrock input and output) stays in S3; only S3 keys
   pass through the state, which keeps it under the 256 KB limit.
7. The dashboard reads the status from Aurora. Once `ready`, CloudFront
   serves the HLS files from `processed/` with a signed cookie.

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

- **Sign-in:** the ALB runs the Cognito login and adds an
  `x-amzn-oidc-data` header to each request. A small API middleware verifies
  the header's ES256 signature with the ALB public key, downloaded over HTTPS
  from the regional ALB key endpoint, and reads the user ID from it.
- **No bypass:** the ALB security group accepts traffic only from the
  CloudFront origin-facing prefix list, so requests cannot skip WAF.
- **Uploads:** `PUT /api/files/...` with an HMAC-signed, 15-minute URL, on
  AWS and locally.
- **Playback on AWS:** CloudFront `/media/*` with signed cookies. One API
  endpoint issues the cookie for a video the user owns, signed with Go's
  `crypto/rsa`; the private key is in Secrets Manager. Key rotation is not
  planned yet.
- **Playback locally:** `GET /api/files/...` with an HMAC-signed URL. This
  route is for local dev only.

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
   DB Subnet: Aurora writer         DB Subnet: (later: Aurora reader)
```

Traffic path: `Internet -> CloudFront -> ALB -> EC2 (ECS task) -> Aurora`.
Instances have no public IPs and no SSH port; a shell comes through Session
Manager. Outbound traffic (ECR pulls) goes through one NAT Gateway; an S3
gateway endpoint keeps the large video transfers off the NAT, which bills
per GB.

### Scaling

- **API tasks**: ECS target tracking on average CPU at 60%.
- **Worker tasks**: one short task per video, started by Step Functions.
  They only reshape JSON, so they share the API's instances.
- **EC2 instances**: an ECS capacity provider with managed scaling grows and
  shrinks the Auto Scaling group so the tasks have room.
- **Media jobs**: MediaConvert, Transcribe, Rekognition and Bedrock are
  managed services; their quotas are the limit. A Standard state machine has
  no concurrency cap, so a burst of uploads relies on the Retry with backoff.

### Alternatives considered

| Choice | Picked | Rejected and why |
|---|---|---|
| Upload path | Through the API to Mountpoint | Presigned PUT straight to S3: needs request signing, which means the SDK or hand-written SigV4. CloudFront OAC PUT: needs per-part signing for big files, loses the no-overwrite guard, and splits local dev from AWS. |
| Watermark and previews | MediaConvert (image inserter, frame capture) | An ffmpeg task: re-encodes what MediaConvert already produced, and Mountpoint cannot seek back to finish an MP4. |
| Transcript to Bedrock | Small Go worker task | Doing it inside the state machine: a long transcript passes the 256 KB state limit, and there is no code step without the SDK. |
| Status updates | One Postgres function, called by both API and pipeline | Pipeline writes a results file that the API reads back: a lagging dashboard and extra read code. |

### Known limits

- **Uploads pass through the API hosts.** That is network work, not the CPU
  work the problem statement is about. A very slow upload can hit the
  CloudFront or ALB timeout, and scale-in can cut off an upload in progress.
- **One NAT Gateway in AZ A.** If AZ A fails, instances in AZ B cannot pull
  images. Accepted for cost.
- **Max video:** 5 GiB per upload and 4 hours (Transcribe's limit).
- **Retention:** the `expire-test-uploads` rule deletes `uploads/` after
  3 days. That is a test setting. Playback after `ready` comes from
  `processed/`, so expiry only blocks re-processing an old video.
- **Cost:** EC2, the NAT Gateway, the ALB and Aurora bill by the hour even
  when idle. Tear the stack down after demos.
- **Region:** the default is `ap-south-1`. The Bedrock model and the
  Rekognition Video features must be checked there before the state machine
  is built.

### Later

- Search: Postgres full-text search over transcript, summary and tags.
- Showing Rekognition labels and moderation flags in the UI.
- An Aurora reader in AZ B, customer-managed KMS keys, Container Insights.

### AWS services in scope

| Category | Services |
|---|---|
| Compute | EC2, Launch Templates, Auto Scaling groups, ECS (EC2 launch type) with capacity providers, ECR, EBS gp3 |
| Networking & delivery | VPC, Subnets, Route Tables, Internet Gateway, NAT Gateway, S3 gateway endpoint, Security Groups, Application Load Balancer, CloudFront, Route 53, ACM |
| Storage & database | S3 (SSE-S3 encryption, lifecycle expiry on uploads/), Mountpoint for S3, Aurora PostgreSQL with the RDS Data API |
| Orchestration | EventBridge, Step Functions (Standard) |
| Media & AI | MediaConvert, Transcribe, Rekognition Video, Amazon Bedrock |
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
- Compute: launch template (installs Mountpoint), Auto Scaling group, ECS
  cluster, capacity provider, task definitions, services, scaling policies,
  ECR
- Data: Aurora, S3 bucket (lifecycle, encryption, EventBridge notifications)
- Pipeline: EventBridge rule, Step Functions state machine, MediaConvert
  role, SNS topic
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
| MediaConvert, Transcribe, Rekognition, Bedrock | Step Functions service integrations | State machine definition |
| Run the worker task | Step Functions `ecs:runTask.sync` | State machine definition |
| Update video status | Step Functions -> RDS Data API -> `set_video_status` | State machine definition |
| Send email | Step Functions -> SNS | State machine definition |
| Read secrets | ECS injects Secrets Manager values as env vars | Task definition |
| Sign-in | ALB `authenticate-cognito` action | ALB listener rule |
| Check who the user is | API downloads the ALB public key over HTTPS (not an SDK call) | API middleware |
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

To do, in build order:
- [ ] Terraform: SNS topic
- [ ] Terraform: Step Functions state machine with MediaConvert, Transcribe,
      Rekognition, the worker task and Bedrock
- [ ] Go worker (`cmd/worker`): transcript to Bedrock request body
- [ ] Dockerfiles for the API (with the worker) and Nginx; push to ECR
- [ ] Terraform: VPC, ALB, EC2 Auto Scaling group (Mountpoint), ECS, Aurora
      with Data API
- [ ] Replace JWT auth with Cognito on the ALB and the identity middleware
- [ ] Terraform: CloudFront, WAF, Route 53, Cognito, alarms, CloudTrail;
      playback cookie endpoint

## How this is being built

- **Frontend**: React + TypeScript + Vite + Tailwind
- **Backend**: Go (Gin) API, Postgres, no AWS SDK
- **Worker task**: a `cmd/worker` subcommand in the API image. Step
  Functions passes the video key as an env var; the task reads and writes
  small JSON files through the Mountpoint folder, which ECS bind-mounts from
  the host
- **Infrastructure**: AWS Console to learn each service, then Terraform

## Project layout

```
backend/
  cmd/server/         API server entrypoint
  internal/config/    env-based configuration
  internal/db/        Postgres connection + embedded SQL migrations
  internal/models/    shared data types
  internal/store/     SQL queries
  internal/auth/      JWT + password hashing (to be replaced by Cognito on the ALB)
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

Requires Go 1.23+, Node 20+, and Docker (for Postgres).

```bash
# Postgres
docker run -d --name videointell-pg -p 5432:5432 \
  -e POSTGRES_USER=videointell -e POSTGRES_PASSWORD=videointell -e POSTGRES_DB=videointell \
  postgres:16-alpine

# Backend
cd backend
go run ./cmd/server

# Frontend
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`, register an account, and upload a video. It is
saved under `backend/data/`. On AWS the same code writes to `/mnt/videos`,
the Mountpoint for S3 folder, by setting `LOCAL_DATA_DIR`.

## Environment variables

### Backend

Read from the process environment (`.env` files are not loaded automatically).
Every variable has a local-dev default.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | API listen port |
| `DATABASE_URL` | `postgres://videointell:videointell@localhost:5432/videointell?sslmode=disable` | Postgres connection string; on AWS built from the Secrets Manager value ECS injects |
| `JWT_SECRET` | `dev-secret-change-me` | Signs JWTs and the short-lived `/api/files/...` upload and playback URLs (HMAC-SHA256); outside local dev, use at least 32 random bytes. After the move to Cognito it only signs file URLs and will be renamed |
| `LOCAL_DATA_DIR` | `./data` | Video folder; `/mnt/videos` (Mountpoint for S3) on AWS |
| `REQUIRE_MOUNT` | _(empty)_ | Set to `true` on AWS: the API refuses to start if `LOCAL_DATA_DIR` is not a mount point, so uploads never land on the instance disk by mistake |

### Frontend

Put these in `frontend/.env` (git-ignored; Vite loads it automatically).

| Variable | Default | Description |
|---|---|---|
| `VITE_API_BASE_URL` | `http://localhost:8080` | Backend API base URL |
