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

## What it does

Upload a long video (a meeting, lecture, tutorial or screen recording) and
about a minute later you get:

- **Adaptive HLS streaming** with a thumbnail, chapters and captions.
- **A transcript** that follows playback; click a line to jump there.
- **On-screen text**: every 3 seconds the worker reads the text in the frame
  (slides, code, terminal output, UI labels) with Tesseract OCR.
- **One search box** that finds a moment by what was said or shown. It
  suggests matches as you type; Enter shows all results and an **AI answer**
  (Amazon Nova Lite) whose timestamps come from real transcript or screen
  lines. On a video page it searches and answers about that video;
  elsewhere, about all your videos.
- **Clips**: save a time range of up to 5 minutes; a clip plays on its own
  timeline from 0:00.
- **Share links**: the Share button copies a 7-day, read-only link to the
  video for someone without an account; a clip's Share button copies a link
  that opens straight into that clip.
- **Titles and key points**: the summary step also writes a short suggested
  title (shown in the Summary tab with a "Use it" button) and 3 to 5 key
  points with timestamps. The pencil next to the title renames a video
  (`PATCH /api/videos/:id`).
- **Transcript download** as `.vtt` subtitles or `.txt` with timestamps.
- **HD export**: the Export HD button makes a 1080p (or 720p when the source
  is smaller) MP4 from the original upload in a Lambda worker, then offers it
  as a download. A source under 720p is scaled up, which adds size, not detail.
  The original upload must still exist (test expiry: 3 days), the video must
  fit one Lambda run of 15 minutes, and each user gets 5 exports a day
  (`EXPORTS_PER_DAY`).
- **Share menu**: the Share button opens a menu with the browser's share
  sheet where it has one, WhatsApp, Gmail, X, LinkedIn, Telegram, Copy link
  and YouTube (saves the HD file and opens YouTube's upload page). Every
  entry shares the same 7-day link.
- **Keyboard shortcuts** on a video page: Space or K play and pause, left
  and right arrows skip 5 s, F toggles fullscreen (and exits it), M mutes,
  `/` jumps to the search box. They do nothing while you type in a field.

## Rules this project follows

This is a learning project and the serverful twin of my serverless project,
ClimaRoute. The rules that shape every choice below:

- **Best resource per job, not fully serverless:** the API runs on ECS on
  EC2; the heavy processing runs as a Lambda fan-out, because 1,000 parallel
  workers finish a long video in about the time of a short one.
- **AWS SDK only in the Lambda worker:** all other AWS wiring lives in
  Terraform. The API makes three kinds of AWS call itself, all signed with
  hand-written SigV4 from Go's standard library: its Aurora IAM sign-in token
  the Bedrock Converse call behind the AI answer, and the
  asynchronous Lambda invoke for HD export (`backend/internal/awsapi`). The Cognito key download is plain HTTPS.
- **AWS Free plan credits only:** the plan blocks MediaConvert, Transcribe
  (`SubscriptionRequiredException`) and Anthropic models on Bedrock, so
  transcoding and transcription run in our own Lambda workers with ffmpeg
  and whisper.cpp, OCR with Tesseract, and the AI uses Amazon Nova Lite.

Some code exists only because of these rules: HMAC-signed file URLs, the
stdlib SigV4 signer and the Mountpoint folder. That is deliberate, not
accidental complexity.

## Design

> Everything here is built except CloudFront and WAF, which wait on AWS
> verifying the account. Until then the app runs in local hybrid mode (see
> [Running locally](#running-locally)). The [Status](#status) list has details.

- **ECS on EC2** runs the Go API and an Nginx server for the React build on
  one Auto Scaling group.
- **Lambda fan-out** does the heavy work: Step Functions splits each video
  into 15-second chunks and a Distributed Map runs one Lambda per chunk
  (ffmpeg + whisper.cpp, up to 1,000 at once), so a long video takes about
  as long as a short one and processing never takes CPU from the API.
- **CloudFront + WAF + Application Load Balancer** is the public entry point.
  Users sign in with **Amazon Cognito** managed login (OAuth code flow with
  PKCE in the browser); the API checks Cognito's ID token itself.
- **Mountpoint for Amazon S3** mounts the video bucket on each EC2 host, so
  the API saves uploads as plain files and they land in S3.
- **EventBridge + Step Functions** turn each finished upload into a pipeline:
  **Lambda** workers (split, then HLS, thumbnails, transcript and on-screen
  text per chunk, then stitch), **Bedrock** (summary and chapters), then
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
| Heavy work | Step Functions Distributed Map on Lambda | The same: Distributed Map of Go Lambda workers (ffmpeg, whisper.cpp, Tesseract), plus Bedrock |
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
        1. Lambda split: ffmpeg copies the upload into ~15 s chunks
           (cut at keyframes, no re-encode) under work/
           Distributed Map, one Lambda per chunk (up to 1,000 at once):
           HLS ladder capped at source resolution, thumbnails every 10 s,
           on-screen text every 3 s (Tesseract, confident words only),
           whisper.cpp transcript, all shifted to the chunk's start
           Lambda assemble: joins the playlists (DISCONTINUITY between
           chunks), transcripts and screen text; writes VTT, screen.json
           and the Bedrock request
                                              |
        3. Bedrock InvokeModel with S3 input and output -> summary, chapters
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
   (video files, transcripts, screen text, Bedrock input and output) stays in S3;
   only S3 keys pass through the state, which keeps it under the 256 KB
   limit.
7. The dashboard reads the status from Aurora. While a video is being
   processed, its page shows a black player with a percentage worked out
   from `GET /api/videos/:id/progress` (split done, chunks done out of total,
   stitch, summary), which reads marker files the Lambdas write. Once
   `ready`, the player streams the HLS files from `processed/` through a
   signed results-folder URL.

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
  screen text and returns up to 50 moments that contain every word, each
  marked `speech` or `screen`, plus how many videos were searched and which
  are still processing. A screen match counts only where the text first
  appears, so a label that stays on screen is one result.
- **Ask:** `POST /api/ask {q, video_id?}` picks the matching transcript and
  screen lines (with a neighbour each side; at most 30 lines and 12,000
  characters across all videos, or the whole transcript for one video), asks
  Nova Lite through a SigV4-signed Bedrock Converse call, and returns the
  answer with sources. Sources are always lines the server sent, never text
  the model wrote.
- **Clips:** `GET/POST /api/videos/:id/clips` and `DELETE .../clips/:clip`.
  A clip is a saved range of 1 second to 5 minutes; nothing is re-encoded.
  The browser builds a small HLS playlist from the segments that cover the
  range, so the clip plays on its own timeline.
- **Share links:** `POST /api/videos/:id/shares` returns a token (32 random
  bytes, shown once; only its SHA-256 is stored) for a 7-day link
  `/share/<token>`, or `/share/<token>?clip=<id>` for a clip. `GET
  /api/share-view` (token in the `X-Share-Token` header, so it never reaches
  the request log) returns the title, clips and a signed folder URL that
  lasts 5 minutes; the share page renews it every 4 minutes and rewrites
  every segment request to the newest one. `/api/share-files/...` has its own
  signing scope and serves only the player's files (summary, transcript,
  captions, screen text, thumbnails, HLS). Up to 50 active links per video,
  enforced in one SQL statement. List and cancel routes exist in the API but
  not in the UI yet.
- **Delete:** `DELETE /api/videos/:id` removes the upload, its marker, the
  results and the work chunks through Mountpoint, then the database row
  (its clips and share links go with it).
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
- **Processing**: one Lambda per 15-second chunk, capped by the Map's
  `MaxConcurrency` (1,000) and the account's Lambda concurrency (1,000 in
  ap-south-1). Measured: the test clip took 58 s end to end, against about
  220 s with the old EC2 worker starting cold.
- **Managed calls**: Bedrock quotas are the limit; every pipeline call
  retries with backoff.

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
- **Max video:** 1 GB and 20 minutes by default (`MAX_UPLOAD_MB`,
  `max_video_minutes`); the hard ceiling is about 4.5 GiB, because the split
  Lambda keeps the upload and its chunks in its 10 GB `/tmp`.
- **Abuse limits:** 3 uploads per user and 30 across the site per day, 30 AI
  answers per user per hour and 100 accounts in all, by default. A question
  about one video sends its whole transcript only up to 40,000 characters;
  longer videos send the matching lines instead. The Ask counter lives in
  the API's memory, so it resets on restart and is per instance.
- **Sign-in:** tokens must carry `email_verified = true`. The API refuses to
  start on AWS (`REQUIRE_MOUNT=true`) with the default or a short
  `JWT_SECRET`; `run-hybrid.sh` makes a random one for each run.
- **Chunk edges:** whisper hears each 15-second chunk on its own, so a word
  cut at an edge can come out wrong.
- **On-screen text:** Tesseract reads printed text well and handwriting or
  very small text poorly; frames are read every 3 seconds, so text shown for
  less than that can be missed. Videos processed before OCR was added have
  no `screen.json`; re-upload them to get it.
- **Clips:** a clip's timeline rounds out to whole HLS segments, so it can
  be a few seconds longer than the range. Safari, which plays HLS natively,
  shows the full video's timeline and pauses at the clip's end.
- **Share links:** a clip link opens the whole video (the clip plays first).
  Links cannot be cancelled from the UI yet; they expire after 7 days or when
  the video is deleted. In hybrid mode the API runs on the laptop, so links
  only open there until CloudFront is up.
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
- **Region:** `ap-south-1`. Nova Lite works there (checked).

### Later

- Go public: CloudFront and WAF, rate limits on Ask and uploads, and a
  monthly cost check against the remaining credits.
- Sharing a highlight reel (a share link that spans several videos)
- Postgres full-text search over transcripts and screen text, when
  libraries outgrow file scanning.
- A stronger speech model for Indian accents and mixed Hindi and English.
- An Aurora reader in AZ B, customer-managed KMS keys, Container Insights.

### AWS services in scope

| Category | Services |
|---|---|
| Compute | Lambda (container image, 10 GB memory and /tmp), EC2, Launch Templates, Auto Scaling group, ECS (EC2 launch type), ECR, EBS gp3 |
| Networking & delivery | VPC, Subnets, Route Tables, Internet Gateway, NAT Gateway, S3 gateway endpoint, Security Groups, Application Load Balancer, CloudFront, Route 53, ACM |
| Storage & database | S3 (SSE-S3 encryption, lifecycle expiry on uploads/), Mountpoint for S3, Aurora PostgreSQL with the RDS Data API |
| Orchestration | EventBridge, Step Functions (Standard) |
| Media & AI | Amazon Bedrock (Nova Lite: summary and chapters in the pipeline, answers in the API); ffmpeg, whisper.cpp and Tesseract run in our Lambda workers |
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

**Console (one-time):** Terraform state bucket, Aurora express cluster
(then imported), SNS email confirmation, first Cognito user. The Cognito
sign-in page style is in Terraform (`infra/branding/settings.json`, dark
graphite and amber to match the app).

**Other tools:** `docker build` and push to ECR; the AWS CLI for manual
checks such as reading a state machine run.

### Who makes each AWS call

| AWS call | Made by | Set up in |
|---|---|---|
| Save upload to S3 | Mountpoint for S3 on the EC2 host | Launch template user data |
| Start the pipeline | S3 -> EventBridge rule on `uploads/*.done` | Terraform |
| Bedrock summary, S3 writes of small results | Step Functions service integrations | State machine definition |
| Bedrock answer (Ask) | The API, SigV4-signed with Go stdlib | `internal/awsapi` |
| Aurora sign-in token | The API, SigV4-signed with Go stdlib | `internal/db` |
| Run the workers | Step Functions `lambda:invoke` and a Distributed Map | State machine definition |
| Worker S3 reads and writes | AWS SDK for Go v2, in the Lambda code only | `cmd/worker` |
| Update video status | Step Functions -> RDS Data API -> `set_video_status` | State machine definition |
| Send email | Step Functions -> SNS | State machine definition |
| Read secrets | ECS injects Secrets Manager values as env vars | Task definition |
| Sign-in | Cognito managed login, OAuth code flow with PKCE | React app (`src/auth.ts`) |
| Check who the user is | API downloads Cognito's JWKS over HTTPS (not an SDK call) | API middleware (`internal/cognito`) |
| Playback and share files | The API checks an HMAC-signed path, one scope for owners and one for share links | `internal/storage` |

The AWS SDK appears only in `cmd/worker`. No CDK, SAM or CloudFormation.

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
      15 s chunks, Distributed Map (up to 1,000 Lambdas), assemble;
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
- [x] App: graphite and amber theme with Motion, delete (S3 and Aurora),
      transcript that follows playback, search that opens the video at the
      moment
- [x] Rekognition labels removed (not used); chunks cut to 15 s
- [x] On-screen text search: Tesseract in the worker Lambda, `screen.json`,
      matches marked "On screen"
- [x] One search box: type-ahead suggestions, Enter for all results and an
      AI answer (Nova Lite, SigV4-signed from the API) for this video or all
      videos
- [x] Clips with clip-only playback; share links for videos and clips
      (7 days, shown once, own signing scope)
- [x] Video page: player and chapters on the left, a sidebar with
      Transcript, Clips and Summary tabs; icon buttons; processing shows a
      percentage
- [x] Cognito sign-in page styled from Terraform; minimum password length 8
- [ ] WAF on CloudFront (after CloudFront)
- [ ] Public launch: rate limits, cost check, security pass
- [x] Highlight reels: "Watch all N moments" on the Search page (shown when matches come from 2+ videos) joins every matching moment (2 s before to 12 s after) across videos into one HLS playlist in the browser

## How this is being built

- **Frontend**: React + TypeScript + Vite + Tailwind
- **Backend**: Go (Gin) API, Postgres, no AWS SDK (signs its Aurora IAM
  token and Bedrock calls with stdlib SigV4)
- **Workers**: one `cmd/worker` Lambda image with ffmpeg, whisper.cpp and
  Tesseract and three operations (`split`, `chunk`, `assemble`). Lambda cannot use
  Mountpoint, so this is the one place the AWS SDK is used (S3 get and put)
- **Infrastructure**: AWS Console to learn each service, then Terraform

## Project layout

```
backend/
  cmd/server/         API server entrypoint
  cmd/worker/         Lambda entrypoint (split, chunk, assemble; S3 via SDK)
  internal/worker/    ffmpeg, whisper.cpp, Tesseract, playlist and transcript stitching
  internal/awsapi/    stdlib SigV4 signer and the Bedrock Converse client
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
  src/pages/          Dashboard, Upload, VideoDetail, Search, SharePage, AuthCallback
  src/components/     Shell (top bar, search), AskCard, ClipsPanel, ClipControls, Icons, VideoCard
  src/lib/            clip playlist builder, search snippets, time helpers
infra/                base stack: S3, Lambda, Step Functions, Aurora, Cognito, ops
infra/app/            app stack (hourly-billed): ALB, API Auto Scaling group, ECS services
infra/branding/       Cognito sign-in page style
docs/designs/         feature specs (Ask, clips and share links)
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

# Frontend: write the Cognito settings once, then plain npm run dev
cd frontend
npm install
printf 'VITE_COGNITO_DOMAIN=%s\nVITE_COGNITO_CLIENT_ID=%s\n' \
  "$(terraform -chdir=../infra output -raw cognito_domain)" \
  "$(terraform -chdir=../infra output -raw cognito_client_id)" > .env.local
npm run dev
```

Open `http://localhost:5173` and sign up on the Cognito page. Uploads are
saved under `backend/data/`, which the pipeline never sees.

**Hybrid mode (local app, real pipeline):** this is how the app runs until
CloudFront is up. Mount the bucket with Mountpoint for S3 and start the API
with `backend/run-hybrid.sh`, which loads your AWS CLI credentials and reads
the Aurora endpoint and Cognito IDs from the Terraform outputs. Uploads land
in S3, the Lambda pipeline processes them, and Ask calls Bedrock with your
CLI credentials:

```bash
mount-s3 <bucket> ~/mnt/videos --region ap-south-1 --allow-delete
backend/run-hybrid.sh
```

The API runs its SQL migrations on every start (`internal/db/migrations`,
all idempotent): `0004` adds `clips`, `0005` adds `share_links`.

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
| `AWS_REGION` | `ap-south-1` | Region for the IAM token, Bedrock and the Cognito issuer |
| `BEDROCK_MODEL_ID` | `apac.amazon.nova-lite-v1:0` | Inference profile the Ask answer uses |
| `MAX_UPLOAD_MB` | `1024` | Largest upload; checked when the video is created and while the file is written |
| `MAX_UPLOADS_PER_DAY` | `3` | New videos per user in any 24 hours |
| `MAX_UPLOADS_PER_DAY_TOTAL` | `30` | New videos across the whole site in any 24 hours; caps the Lambda spend |
| `ASK_PER_HOUR` | `30` | AI answers per user per hour (counted in the API's memory) |
| `MAX_USERS` | `100` | Accounts allowed; a new sign-in past this gets "sign-ups are full" |
| `WORKER_FUNCTION` | empty | Name of the worker Lambda; HD export is off while it is empty (`run-hybrid.sh` sets it) |
| `VIDEO_BUCKET` | empty | Bucket the worker reads the original from (`run-hybrid.sh` sets it) |
| `EXPORTS_PER_DAY` | `5` | HD exports per user in any 24 hours (counted in the API's memory) |

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
| `TESSERACT_BIN` | `/usr/bin/tesseract` in the image | Reads on-screen text every 3 s into `screen.json`; empty skips it |
| `CHUNK_SECONDS` | `15` (Terraform `chunk_seconds`) | Chunk length for the fan-out |
| `MAX_VIDEO_MINUTES` | `20` (Terraform `max_video_minutes`) | Split refuses longer videos before any chunk work, so the pipeline marks them failed |

Terraform variables: `max_chunk_workers` (Map concurrency, 1000),
`worker_memory_mb` (10240; use 3008 if the account caps Lambda memory).
`go test ./internal/worker/` runs split, chunk and assemble locally with a
folder in place of S3.

### Frontend

Put these in `frontend/.env.local` (git-ignored; Vite loads it automatically).

| Variable | Default | Description |
|---|---|---|
| `VITE_API_BASE_URL` | `http://localhost:8080` | Backend API base URL; empty behind CloudFront (same origin) |
| `VITE_COGNITO_DOMAIN` | _(required)_ | `terraform -chdir=infra output -raw cognito_domain` |
| `VITE_COGNITO_CLIENT_ID` | _(required)_ | `terraform -chdir=infra output -raw cognito_client_id` |
