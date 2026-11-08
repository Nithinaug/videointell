# Stage 6: Comprehension Test Report

- **Target:** `README.md`, lines 1-317. FeatureRange is lines 1-317; DetailedRange is N/A.
- **Reviewer:** egm-comprehension, in a fresh context. It read only the README, to test whether the document makes sense on its own.

**What to check:** the two paraphrases below are how a new reader understood your design. Anywhere they differ from what you meant shows a gap in the README.

**What this proposes**
- **What it does:** Users upload recordings. The system turns each one into HLS renditions, thumbnails, subtitles, labels and moderation flags, an AI summary with chapters and tags, and ffmpeg extras such as a preview GIF and a watermark.
- **How it's built:** The target is "serverful" on AWS, built with the Console and Terraform under one rule: the Go app never calls AWS directly. Every AWS call is a service integration set up in Terraform.
- **The flow:**
  1. The API writes each upload to a Mountpoint-for-S3 folder, so the file lands in S3 `uploads/`.
  2. EventBridge starts a Step Functions pipeline.
  3. MediaConvert runs, then Transcribe and Rekognition in parallel, then Bedrock, then an ffmpeg ECS task.
  4. Results are recorded in Aurora through the RDS Data API, and SNS sends an email.
- **Sign-in and playback:** sign-in is meant to move to Cognito on the ALB, and playback to CloudFront with signed cookies.

**How the existing system works, per this document**
- **Today:** a Go (Gin) API with Postgres and a React/Vite frontend. It has its own JWT auth with register and login pages.
- **Files:** uploads and playback use a local folder (`backend/data/`, set by `LOCAL_DATA_DIR`), served through short-lived HMAC-signed `/api/files/...` URLs. The AWS SDK has already been removed.
- **On AWS:** Terraform manages only the S3 bucket, imported from the Console, and an EventBridge rule that logs upload events to CloudWatch Logs. Everything else in the Architecture section is not built yet.

## Findings

| # | Severity | Scope | Finding |
|---|---|---|---|
| C1 | 🟡 Major | Proposed solution, Architecture, Workflow vs Status, Project layout, Running locally, `JWT_SECRET` | The target design is written in the present tense, for example "the ALB signs users in with Cognito, so there is no auth code in the app". Elsewhere, the README describes JWT auth with Register and Login pages. Only the Status list separates what's built from what's planned. The "Register" step conflicts with "first Cognito user" being a Console task, and the README never says whether self-registration survives. |
| C2 | 🟡 Major | `JWT_SECRET` row; playback design | HMAC-signed `/api/files/...` URLs appear only in one table cell. The README doesn't say whether they, and `JWT_SECRET`, stay once Cognito arrives. Upload authorisation is unclear: line 158 has the browser post straight to the API, but line 308 mentions signed upload URLs. |
| C3 | 🟡 Major | CloudFront signed cookies | The README doesn't say who issues the cookie, at which endpoint or step, or where the RSA private key is kept. |
| C4 | 🟡 Major | Workflow steps 3-9 | Nothing says how the state machine finds the matching Aurora row (by object key? by an ID carried in the event?). Nothing says which S3 prefix `/mnt/videos` maps to. |
| C5 | 🟡 Major | Processing steps 2a, 2b and 3; "No SDK" table | MediaConvert and ECS are marked `.sync`, but nothing says how the pipeline waits for Transcribe and Rekognition, or how the transcript gets from S3 into Bedrock InvokeModel. |
| C6 | 🟢 Nit | ffmpeg task | Nothing says how the container reaches the mount on the host (a bind-mounted volume?), or which env vars Step Functions passes in. |
| C7 | 🟢 Nit | `DATABASE_URL` vs "Read DB password" | Nothing says what builds the URL from the secret, or whether the secret holds a password or a full URL. |
| C8 | 🟢 Nit | Scaling | "The state machine's concurrency is the cap" is vague: nothing says what limits concurrency or what the cap is. |
| C9 | 🟢 Nit | Status values | Only `uploaded`, `ready` and `failed` appear. Is there a status for "in progress"? |
| C10 | 🟢 Nit | Request-path diagram | One box holds both `uploads/` and `processed/`, so it doesn't show that uploads go to one and playback reads from the other. |
| C11 | 🟢 Nit | ClimaRoute | It has no link. The comparison is still readable without one. |
| C12 | 🟢 Nit | Running locally | Docker is the real requirement, but it isn't listed. |
| C13 | 🟢 Nit | Services in scope; Console tasks | The `uploads/` expiry period and the Bedrock model that needs access aren't named. |

## Overlap with Stage 5

C4 and C5 independently confirm Stage 5's M2 and M3 (the two writers on the video row, and the hidden glue work). C2 and C3 confirm M7 (the two playback paths). Three reviewers have now flagged these on their own.
