# Video Intelligence & Processing Platform

## Problem statement

Organizations and individuals generate large amounts of video content
(meetings, lectures, interviews, training sessions, webinars, tutorials) that
is hard to manage, search, and consume. Users have to watch an entire video
to find specific information, and manually create transcripts and summaries.
Processing video on the same server that answers web requests also
starves the app of CPU when many users upload at once, so the heavy work has
to run on its own fleet that scales with the backlog.

## Proposed solution

A **serverful** platform on AWS: every piece of compute is an EC2 instance we
size, patch and scale ourselves, managed with the AWS Console and Terraform.
Users upload straight to S3, and a fleet of worker servers does the heavy
video work instead of managed media services.

- **EC2 Auto Scaling group + ECS (EC2 launch type)** runs three containers:
  the Go API, an Nginx server for the React build, and the video worker
- **Application Load Balancer** is the single public entry point, routing
  `/api/*` to the API and everything else to Nginx
- **Amazon S3** holds original videos, processed videos and transcripts
- **S3 event notifications + Amazon SQS** turn each upload into a job
- **Worker containers** poll SQS and do the processing on the instance:
  **ffmpeg** transcodes, **whisper.cpp** transcribes on CPU,
  **Amazon Bedrock** writes the summary, chapters and action items
- **Amazon RDS (Postgres)** stores users, videos, job status and results
- **ECS service auto scaling** adds worker tasks as the SQS backlog grows,
  and the **ECS capacity provider** adds EC2 instances to fit them

Everything runs in a VPC across two Availability Zones, with instances in
private subnets, no SSH (Systems Manager Session Manager instead),
least-privilege IAM roles, Secrets Manager for credentials and CloudWatch
for logs, metrics and alarms.

### Serverless vs serverful

The same jobs done the opposite way from my serverless project, ClimaRoute:

| Job | ClimaRoute (serverless) | This project (serverful) |
|---|---|---|
| API compute | Lambda (container images) | Go API container on EC2 (ECS, EC2 launch type) |
| Public entry, throttling | API Gateway HTTP API | Application Load Balancer + AWS WAF rate rule |
| Heavy parallel work | Step Functions Distributed Map | Worker containers on EC2 pulling from SQS |
| Long-running jobs | ECS Fargate | ECS on an EC2 Auto Scaling group |
| Database | DynamoDB (TTL expiry) | RDS Postgres |
| Scheduled work, keep-warm | EventBridge | Not needed: servers are always warm |
| Frontend hosting | Amplify Hosting | Nginx container behind the ALB |
| Scaling | Per request, automatic | Target tracking on CPU and SQS backlog, capacity provider adds instances |
| Shared | S3, ECR, CloudWatch, Budgets | S3, ECR, CloudWatch (+ agent), Budgets |

The one managed service kept is Bedrock: running an LLM yourself needs a
GPU instance (g5 class), which costs far more than a demo is worth.

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
               |  Application Load   |
               |  Balancer  (+ WAF)  |
               +-----+---------+-----+
              /api/* |         | /*
                     v         v
               +----------+ +----------+
               | API (Go) | |  Nginx   |
               |          | | (React)  |
               +--+----+--+ +----------+
                  |    |
                  |    +-------------------+
     users,       |      presigned upload  |
     videos,      |      and play URLs     |
     job status   v                        v
             +----------+          +---------------+
             |   RDS    |          |      S3       | <--- browser uploads
             | Postgres |          |  originals/   |      and plays videos
             +----------+          |  processed/   |      with those URLs
                                   +---------------+
```

Processing path:

```
   +---------------+   event notification   +-------+
   | S3 originals/ | ---------------------> |  SQS  | ---> dead-letter queue
   +---------------+   one message per      +---+---+      after 3 tries
                       upload                   |
                                                | long poll
                                                v
                                      +-------------------+
                                      |    Worker (Go)    |
                                      +---------+---------+
                                                |
             +-----------------+----------------+----------------+-----------------+
             |                 |                                 |                 |
             v                 v                                 v                 v
     +---------------+ +---------------+                 +---------------+ +---------------+
     |    ffmpeg     | |  whisper.cpp  |                 |    Bedrock    | | S3 processed/ |
     |  transcode +  | | speech->text  |                 | summary,      | | RDS: status   |
     | extract audio | |   on CPU      |                 | chapters,     | |   = ready     |
     |               | |               |                 | action items  | |               |
     +---------------+ +---------------+                 +---------------+ +---------------+
     \_________ on the EC2 instance _________/                (AWS API calls)
```

API, Nginx and Worker are all containers on one ECS cluster, running on an
EC2 Auto Scaling group in private subnets across AZ A and AZ B.

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
   DB Subnet: RDS primary           DB Subnet: RDS standby (optional)
```

Traffic path: `Internet -> ALB -> EC2 (ECS task) -> RDS`. Instances have no
public IPs and no SSH port; you get a shell through Session Manager. Outbound
traffic (ECR pulls, SQS, Bedrock) goes through one NAT Gateway; an S3 gateway
endpoint keeps the large video transfers off the NAT, which bills per GB.

### Video processing workflow

```
1. User requests an upload; API returns a presigned S3 URL
2. Browser uploads the video directly to S3
3. S3 event notification puts a message on SQS
4. A worker container receives the message (the message stays hidden
   while it works)
5. Worker downloads the video to the instance's EBS volume
6. ffmpeg transcodes it and extracts the audio
7. whisper.cpp turns the audio into a transcript
8. Worker sends the transcript to Bedrock for summary, chapters, actions
9. Worker uploads the results to S3, updates the video row in RDS,
   and deletes the SQS message
10. Failed jobs retry; after 3 tries SQS moves them to a dead-letter queue
11. Dashboard shows the status from RDS and plays files via presigned URLs
```

### Scaling

- **Worker tasks**: ECS service auto scaling on the SQS metric
  `ApproximateNumberOfMessagesVisible` (step scaling: 0 messages -> 1 task,
  each 2 waiting messages -> one more task, up to a cap).
- **EC2 instances**: an ECS capacity provider with managed scaling grows
  and shrinks the Auto Scaling group so the tasks have room.
- **API tasks**: target tracking on average CPU at 60%.

### AWS services in scope

| Category | Services |
|---|---|
| Compute | EC2, Launch Templates, Auto Scaling groups, ECS (EC2 launch type) with capacity providers, ECR, EBS gp3 |
| Networking | VPC, Subnets, Route Tables, Internet Gateway, NAT Gateway, S3 gateway endpoint, Security Groups, Application Load Balancer, Route 53 |
| Storage & database | S3, RDS PostgreSQL |
| Queueing | S3 Event Notifications, SQS with a dead-letter queue |
| AI | Amazon Bedrock |
| Security | IAM roles (instance role, task roles), Secrets Manager, Systems Manager Session Manager, AWS WAF |
| Monitoring & cost | CloudWatch Logs, metrics, alarms, CloudWatch agent, AWS Budgets |

## Infrastructure as code

Everything is learned in the **AWS Console** first, then written in
**Terraform**, so the whole stack comes up and goes away with
`terraform apply` / `terraform destroy`. That matters more here than in a
serverless stack: EC2, the NAT Gateway, the ALB and RDS bill by the hour
whether anyone uses them or not.

| Terraform | Console (one-time) | Script |
|---|---|---|
| VPC, subnets, NAT, S3 endpoint, security groups, ALB, launch template, Auto Scaling group, ECS cluster, capacity provider, task definitions, services, scaling policies, ECR, RDS, S3 buckets (CORS, lifecycle, encryption, event notifications), SQS + DLQ, IAM roles, Secrets Manager secret, CloudWatch log groups and alarms, WAF | Terraform state bucket, AWS Budget alert, Bedrock model access | `docker build` + push to ECR |

### Terraform creates, the SDK runs, the CLI is for one-offs

| What | Tool | Where in this project |
|---|---|---|
| Creating infrastructure | Terraform (each service learned in the Console first) | `infra/` |
| Running code talking to AWS | AWS SDK for Go v2 | API: presigned S3 URLs. Worker: `sqs.ReceiveMessage`, `s3.GetObject` / `PutObject`, `bedrockruntime.Converse`, `sqs.DeleteMessage` |
| Manual checks and one-off tasks | AWS CLI | Pushing images, checking a queue, testing an upload |

No SDK, CDK or SAM is used to create infrastructure, and no Terraform is used
for work that happens at runtime.

## Status

- [x] Go API with JWT auth, Postgres, React frontend
- [x] Direct-to-S3 uploads and playback via presigned URLs
- [ ] Terraform: S3 bucket, SQS + DLQ, S3 event notification
- [ ] Worker: SQS poll, ffmpeg, whisper.cpp, Bedrock, results to S3 + RDS
- [ ] Dockerfiles for API, Nginx and worker; push to ECR
- [ ] Terraform: VPC, ALB, EC2 Auto Scaling group, ECS, RDS
- [ ] Scaling policies, CloudWatch alarms, WAF, Route 53

## How this is being built

- **Frontend**: React + TypeScript + Vite + Tailwind
- **Backend**: Go (Gin) API and a Go worker, Postgres, AWS SDK for Go v2
  for runtime calls only
- **Worker tools**: ffmpeg (transcoding), whisper.cpp (transcription), run
  from Go with `exec.Command`
- **Infrastructure**: AWS Console to learn each service, then Terraform

## Project layout

```
backend/
  cmd/server/         API server entrypoint
  internal/config/    env-based configuration
  internal/db/        Postgres connection + embedded SQL migrations
  internal/models/    shared data types
  internal/store/     SQL queries
  internal/auth/      JWT + password hashing
  internal/storage/   S3 presigned URLs, or local filesystem for offline dev
  cmd/worker/         SQS worker: ffmpeg, whisper.cpp, Bedrock (planned)
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

Requires Go 1.23+, Node 20+, and a local Postgres instance. (No Dockerfiles
right now — not needed while everything runs directly on the host.)

```bash
# Postgres
docker run -d --name videointell-pg -p 5432:5432 \
  -e POSTGRES_USER=videointell -e POSTGRES_PASSWORD=videointell -e POSTGRES_DB=videointell \
  postgres:16-alpine

# Backend (local storage)
cd backend
go run ./cmd/server

# Backend (S3 storage)
cd backend
STORAGE_BACKEND=s3 S3_BUCKET=<your-bucket> go run ./cmd/server

# Frontend
cd frontend
npm install
npm run dev
```

Open http://localhost:5173, register an account, and upload a video. With
local storage it's saved under `backend/data/`; with S3 it goes straight from
the browser to the bucket via a presigned URL.

## Environment variables

### Backend

Read from the process environment (`.env` files are not loaded automatically).
Every variable has a local-dev default, so nothing is required for local storage.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | API listen port |
| `DATABASE_URL` | `postgres://videointell:videointell@localhost:5432/videointell?sslmode=disable` | Postgres connection string |
| `JWT_SECRET` | `dev-secret-change-me` | JWT signing secret; must be set to a strong value outside local dev |
| `LOCAL_DATA_DIR` | `./data` | Upload directory when `STORAGE_BACKEND=local` |
| `STORAGE_BACKEND` | `local` | `local` or `s3` |
| `S3_BUCKET` | _(empty)_ | Bucket name; required when `STORAGE_BACKEND=s3` |

AWS credentials and region are never configured here. With `STORAGE_BACKEND=s3`
the AWS SDK resolves them through its default provider chain: `aws configure` /
`AWS_PROFILE` / `AWS_REGION` locally, and the IAM role (ECS task role or EC2
instance role) in production.

### Frontend

Put these in `frontend/.env` (git-ignored; Vite loads it automatically).

| Variable | Default | Description |
|---|---|---|
| `VITE_API_BASE_URL` | `http://localhost:8080` | Backend API base URL |
