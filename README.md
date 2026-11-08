# Video Intelligence & Processing Platform

## Problem statement

Organizations and individuals generate large amounts of video content
(meetings, lectures, interviews, training sessions, webinars, tutorials) that
is hard to manage, search, and consume. Users have to watch an entire video
to find specific information, and manually create transcripts and summaries.
Processing video on the same server that answers web requests also starves
the app of CPU when many users upload at once, so the heavy work has to run
somewhere else.

## Proposed solution

A **serverful** platform on AWS that uses as many AWS services as fit, built
only with the **AWS Console and Terraform**, with **no AWS SDK** in the app.

The rule that makes this work: **AWS services call each other, our code never
calls AWS.** Every runtime AWS call is a service integration set up in
Terraform. The Go API only speaks HTTP, SQL and files.

- **ECS on an EC2 Auto Scaling group** runs the Go API, an Nginx server for
  the React build, and custom ffmpeg tasks. All compute is EC2 we size,
  patch and scale ourselves.
- **CloudFront + WAF + Application Load Balancer** is the public entry
  point; the ALB signs users in with **Amazon Cognito**, so there is no auth
  code in the app.
- **Mountpoint for Amazon S3** mounts the video bucket on each EC2 host, so
  the API saves uploads as plain files and they land in S3.
- **EventBridge + Step Functions** turn each upload into a pipeline:
  **MediaConvert** (HLS renditions, thumbnails), **Transcribe** (subtitles),
  **Rekognition Video** (labels, moderation), **Bedrock** (summary,
  chapters, tags), an **ECS task** for custom ffmpeg work, then results into
  **Aurora PostgreSQL** through the **RDS Data API** and an **SNS** email.
- **Aurora PostgreSQL** (provisioned instance) stores videos, job status
  and results; the API reads it with a normal Postgres driver.
- **CloudFront** plays the processed video from S3 through Origin Access
  Control, protected by signed cookies made with Go's standard crypto.

Everything runs in a VPC across two Availability Zones, with instances in
private subnets, no SSH (Systems Manager Session Manager instead),
least-privilege IAM roles, Secrets Manager for credentials, KMS encryption
and CloudWatch for logs, metrics and alarms.

### Serverless vs serverful

The same jobs done the opposite way from my serverless project, ClimaRoute:

| Job | ClimaRoute (serverless) | This project (serverful) |
|---|---|---|
| API compute | Lambda (container images) | Go API container on EC2 (ECS, EC2 launch type) |
| Public entry, throttling | API Gateway HTTP API | CloudFront + ALB + AWS WAF rate rule |
| Auth | Cognito in the app | Cognito on the ALB listener |
| Heavy work | Step Functions Distributed Map on Lambda | Step Functions driving MediaConvert, Transcribe, Rekognition and ECS tasks on EC2 |
| Long-running jobs | ECS Fargate | ECS on an EC2 Auto Scaling group |
| Database | DynamoDB (TTL expiry) | Aurora PostgreSQL (provisioned) |
| Frontend hosting | Amplify Hosting | Nginx container behind the ALB, cached by CloudFront |
| Scaling | Per request, automatic | Target tracking on CPU, capacity provider adds instances |
| Shared | S3, ECR, CloudWatch, Budgets | S3, ECR, CloudWatch (+ agent), Budgets |

Step Functions and EventBridge are managed glue; every piece of compute that
runs our code is an EC2 instance.

## Architecture

Request path:

```
                    USERS (browser)
                          |
                          v
                     +----------+
                     | Route 53 |
                     +----+-----+
                          |
                          v
               +---------------------+
               | CloudFront  (+ WAF) |----------------------------+
               +----------+----------+   /media/* (signed cookie) |
                          |                                       |
                          v                                       |
               +---------------------+    sign-in    +---------+  |
               |  Application Load   | <-----------> | Cognito |  |
               |      Balancer       |               +---------+  |
               +-----+---------+-----+                            |
              /api/* |         | /*                               |
                     v         v                                  |
               +----------+ +----------+                          |
               | API (Go) | |  Nginx   |                          |
               |  no SDK  | | (React)  |                          |
               +--+----+--+ +----------+                          |
                  |    |                                          |
       SQL        |    | writes file to /mnt/videos               v
                  v    v                                 +----------------+
          +-----------+  +------------------------+      | S3  processed/ |
          |  Aurora   |  | Mountpoint for S3      | ---> | S3  uploads/   |
          | Postgres  |  | (on the EC2 host)      |      +----------------+
          +-----------+  +------------------------+
```

Processing path:

```
   +---------------+  Object Created  +-------------+
   | S3 uploads/   | ---------------> | EventBridge |
   +---------------+                  +------+------+
                                             |
                                             v
                               +---------------------------+
                               |  Step Functions (Standard)|
                               +-------------+-------------+
                                             |
        1. MediaConvert (.sync) -> HLS 1080/720/480 + thumbnails
                                             |
             +-------------------------------+-------------------------------+
             | 2a. Transcribe                                                | 2b. Rekognition Video
             |     -> VTT/SRT subtitles                                      |     -> labels, moderation
             +-------------------------------+-------------------------------+
                                             |
        3. Bedrock InvokeModel -> summary, chapters, tags (from the transcript)
                                             |
        4. ECS RunTask (.sync) on the EC2 cluster -> ffmpeg preview GIF, watermark
                                             |
        5. RDS Data API -> video row in Aurora: status = ready, results
                                             |
        6. SNS -> "video ready" email

   Any failure: Catch -> RDS Data API sets status = failed -> SNS alert
```

API, Nginx and the ffmpeg tasks run on one ECS cluster, on an EC2 Auto
Scaling group in private subnets across AZ A and AZ B.

### Network architecture

```
                         VPC
                          |
          +---------------+----------------+
          |                                |
   Availability Zone A              Availability Zone B
          |                                |
   Public Subnet: ALB, NAT          Public Subnet: ALB
   Private Subnet: EC2 (ECS)        Private Subnet: EC2 (ECS)
   DB Subnet: Aurora writer         DB Subnet: Aurora reader (optional)
```

Traffic path: `Internet -> CloudFront -> ALB -> EC2 (ECS task) -> Aurora`.
Instances have no public IPs and no SSH port; you get a shell through
Session Manager. Outbound traffic (ECR pulls) goes through one NAT Gateway;
an S3 gateway endpoint keeps the large video transfers off the NAT, which
bills per GB.

### Video processing workflow

```
1. User signs in through Cognito on the ALB
2. Browser posts the video to the API; the API writes it to /mnt/videos
   (Mountpoint for S3), so it lands in S3 uploads/
3. The API inserts a video row in Aurora with status = uploaded
4. S3 sends an Object Created event to EventBridge, which starts the
   Step Functions state machine
5. MediaConvert makes HLS renditions and thumbnails in S3 processed/
6. Transcribe and Rekognition Video run in parallel
7. Bedrock turns the transcript into a summary, chapters and tags
8. An ECS task on the EC2 cluster runs custom ffmpeg steps, reading and
   writing files through the same Mountpoint mount
9. Step Functions writes the results to Aurora with the RDS Data API and
   sends an SNS email
10. The dashboard reads status from Aurora; CloudFront plays the HLS files
    with a signed cookie
```

### Scaling

- **API tasks**: ECS target tracking on average CPU at 60%.
- **ffmpeg tasks**: one task per video, started by Step Functions; the
  state machine's concurrency is the cap.
- **EC2 instances**: an ECS capacity provider with managed scaling grows
  and shrinks the Auto Scaling group so the tasks have room.
- **Media jobs**: MediaConvert, Transcribe, Rekognition and Bedrock scale
  on their own; their service quotas are the limits.

### AWS services in scope

| Category | Services |
|---|---|
| Compute | EC2, Launch Templates, Auto Scaling groups, ECS (EC2 launch type) with capacity providers, ECR, EBS gp3 |
| Networking & delivery | VPC, Subnets, Route Tables, Internet Gateway, NAT Gateway, S3 gateway endpoint, Security Groups, Application Load Balancer, CloudFront, Route 53, ACM |
| Storage & database | S3 (lifecycle expiry on uploads/), Mountpoint for S3, Aurora PostgreSQL with the RDS Data API |
| Orchestration | EventBridge, Step Functions (Standard) |
| Media & AI | MediaConvert, Transcribe, Rekognition Video, Amazon Bedrock |
| Notifications | SNS |
| Security | Cognito, IAM roles (instance, task, state machine), Secrets Manager, KMS, Systems Manager Session Manager, AWS WAF, CloudTrail |
| Monitoring & cost | CloudWatch Logs, metrics, alarms, Container Insights, CloudWatch agent, AWS Budgets |

## Infrastructure as code

Every service is learned in the **AWS Console** first, then written in
**Terraform**, so the whole stack comes up and goes away with
`terraform apply` / `terraform destroy`. That matters more in a serverful
stack: EC2, the NAT Gateway, the ALB and Aurora bill by the hour whether
anyone uses them or not.

| Terraform | Console (one-time) | Script |
|---|---|---|
| VPC, subnets, NAT, S3 endpoint, security groups, ALB, CloudFront, WAF, ACM, Route 53 records, Cognito user pool, launch template (installs Mountpoint), Auto Scaling group, ECS cluster, capacity provider, task definitions, services, scaling policies, ECR, Aurora, S3 buckets (lifecycle, encryption, EventBridge notifications), EventBridge rule, Step Functions state machine, MediaConvert role, SNS topic, IAM roles, Secrets Manager secret, KMS keys, CloudTrail, CloudWatch log groups and alarms | Terraform state bucket, AWS Budget alert, Bedrock model access, SNS email confirmation, first Cognito user | `docker build` + push to ECR |

### No SDK: who makes each AWS call

| AWS call | Made by | Set up in |
|---|---|---|
| Save upload to S3 | Mountpoint for S3 on the EC2 host | Launch template user data |
| Start the pipeline | S3 -> EventBridge rule | Terraform |
| MediaConvert, Transcribe, Rekognition, Bedrock | Step Functions service integrations | State machine definition |
| Run ffmpeg task | Step Functions `ecs:runTask.sync` | State machine definition |
| Write job results | Step Functions -> RDS Data API | State machine definition |
| Send email | Step Functions -> SNS | State machine definition |
| Read DB password | ECS injects the Secrets Manager value as an env var | Task definition |
| Sign-in | ALB `authenticate-cognito` action | ALB listener rule |
| Private playback | CloudFront signed cookies (Go standard RSA, not the SDK) | CloudFront key group |

The AWS CLI is only for manual checks (pushing images, reading a state
machine run). No SDK, CDK or SAM anywhere.

## Status

- [x] Go API, Postgres, React frontend
- [x] Uploads and playback through local storage
- [x] AWS SDK removed: the API only writes and reads files, which become S3
      objects through the Mountpoint folder on AWS
- [ ] Replace JWT auth with Cognito on the ALB
- [x] Terraform: S3 bucket (imported from the Console), EventBridge rule
      logging to CloudWatch Logs until Step Functions is the target
- [ ] Terraform: SNS topic
- [ ] Terraform: Step Functions state machine with MediaConvert, Transcribe,
      Rekognition, Bedrock
- [ ] Dockerfiles for API, Nginx and the ffmpeg task; push to ECR
- [ ] Terraform: VPC, ALB, EC2 Auto Scaling group (Mountpoint), ECS, Aurora
      with Data API
- [ ] Terraform: CloudFront, WAF, Route 53, Cognito, alarms, CloudTrail

## How this is being built

- **Frontend**: React + TypeScript + Vite + Tailwind
- **Backend**: Go (Gin) API, Postgres, no AWS SDK
- **ffmpeg task**: a container that reads its input path from env vars set
  by Step Functions and works on the Mountpoint folder
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

Requires Go 1.23+, Node 20+, and a local Postgres instance.

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

Open http://localhost:5173, register an account, and upload a video. It is
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
| `JWT_SECRET` | `dev-secret-change-me` | Signs JWTs and the short-lived `/api/files/...` upload and playback URLs (HMAC-SHA256); must be strong outside local dev |
| `LOCAL_DATA_DIR` | `./data` | Video folder; `/mnt/videos` (Mountpoint for S3) on AWS |

### Frontend

Put these in `frontend/.env` (git-ignored; Vite loads it automatically).

| Variable | Default | Description |
|---|---|---|
| `VITE_API_BASE_URL` | `http://localhost:8080` | Backend API base URL |
