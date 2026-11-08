# Stage 5: Initial Zoom Out Report

- **Target:** `README.md`, lines 1-317. Reviewed as one feature spec, because the README has no implementation plan section.
- **Reviewers:** egm-zoom-out and egm-inventive-catalyst. Each ran in a fresh context with no chat history.
- **Background files (Goldfish context):** `infra/main.tf`, `infra/s3.tf`, `infra/eventbridge.tf`, `backend/internal/storage/local.go`, `backend/internal/handlers/videos.go`, `backend/internal/router/router.go`

**Verdict:** Needs revision. There are no Blockers. The reviewers raised 10 Major findings, which merge into 8 unique issues, and 7 Nits.

## Merged findings

Both reviewers raised three of the issues on their own. Those are marked **[both]**.

| # | Severity | Issue | Raised by |
|---|---|---|---|
| M1 | 🟡 Major | The ffmpeg tasks share an Auto Scaling group with the API. That brings back the CPU starvation the problem statement says the design solves. MediaConvert can already do the watermark and frame captures. | **[both]** ZO-M2, IC-1 |
| M2 | 🟡 Major | The video row has two writers: the API through Postgres, and Step Functions through the RDS Data API. Ownership of the status field is undefined, a late `/complete` call can overwrite `failed`, and the state machine has to find the row by S3 key. | **[both]** ZO-M6, IC-3 |
| M3 | 🟡 Major | The pipeline diagram hides glue work. Transcribe and Rekognition have no `.sync` integration, so each needs a poll loop or a callback. Getting the transcript into Bedrock hits the 256 KB Step Functions payload limit, and nothing says where that work happens. | **[both]** ZO-M5, IC-4 (part) |
| M4 | 🟡 Major | There's no real concurrency cap. Each upload starts its own run, and a hit service quota goes straight to Catch → `failed`, with no Retry or backoff. | IC-4 |
| M5 | 🟡 Major | Search, the main user problem in the problem statement, has no design. | ZO-M1 |
| M6 | 🟡 Major | "No auth code in the app" is wrong. The API still has to verify the ALB's `x-amzn-oidc-data` header and fetch its public key. The ALB needs a CloudFront-only rule, and existing users have to be moved to Cognito `sub` IDs. | ZO-M3 |
| M7 | 🟡 Major | There are two playback paths, HMAC `/api/files` GET and CloudFront `/media/*` cookies, and no rule says which one applies where. HMAC per-file URLs can't protect HLS segments. | ZO-M4 |
| M8 | 🟡 Major | Every upload byte passes through the API host on its way to Mountpoint. Uploading through CloudFront with OAC would skip EC2 and still keep the no-SDK rule. | IC-2 |
| N1 | 🟢 Nit | ffmpeg can't seek inside a Mountpoint file. Work in a local scratch folder, then copy the result to the mount. | IC-5 |
| N2 | 🟢 Nit | The single NAT in AZ A is a hidden single point of failure, so say so in the README or add ECR endpoints. | IC-6 |
| N3 | 🟢 Nit | The README never says why the no-SDK rule exists. | ZO-N1 |
| N4 | 🟢 Nit | Rekognition results have no consumer, so wire them to a feature or defer them. | ZO-N2 |
| N5 | 🟢 Nit | The optional Aurora reader, the KMS keys and Container Insights plus the CloudWatch agent are speculative extras. | ZO-N3 |
| N6 | 🟢 Nit | The Nginx container could be replaced by an S3 origin behind CloudFront. | ZO-N4 |
| N7 | 🟢 Nit | The workflow text doesn't match the code (create, then PUT, then `/complete`), and the 3-day expiry on `uploads/` blocks re-processing old videos. | ZO-N5, ZO note |

## Raw report: egm-zoom-out

**Context check:** passed. The goal is clear: transcripts, summaries and HLS playback on a serverful AWS stack with no SDK, built partly as a learning comparison with ClimaRoute. The README says it wants to use as many services as fit, so service count alone is not flagged.

**ZO-M1: Search has no design.**
- **Problem:** The problem statement says users can't find specific information without watching the whole video. The pipeline produces transcripts, chapters and tags, but there's no search path, query API or index. Status and playback are the only read paths.
- **Suggestion:** Postgres full-text search, a `tsvector` over transcript, summary and tags in the existing Aurora, needs no new service. Otherwise, narrow the problem statement.

**ZO-M2: ffmpeg on the API cluster.**
- **Contradiction:** The problem statement's one technical reason is that video work on the web server starves the app of CPU. The design then puts the API, Nginx and the ffmpeg tasks on one ECS cluster and one Auto Scaling group.
- **Overlap with MediaConvert:** MediaConvert, which is step 1, already does watermarks (image inserter) and frame captures. Watermarking in step 4, after the HLS renditions exist, means re-encoding them or watermarking only a side output. Either way the order is wrong.
- **Suggestion:** Move the watermark into MediaConvert and drop or shrink the ECS task. Otherwise, give that task its own capacity provider, or state the trade-off.

**ZO-M3: "No auth code" is wrong.**
- **Identity header:** Handlers key everything on `user_id`. With Cognito on the ALB, the API has to read and verify the `x-amzn-oidc-data` header (ES256), using a public key fetched from an AWS regional endpoint. That is both auth code and a runtime call to AWS.
- **Bypass:** The ALB has to accept traffic only from CloudFront, through the managed prefix list. Otherwise WAF can be bypassed.
- **User migration:** User IDs change to Cognito `sub` values, which affects the `uploads/<userID>/` prefix.
- **Suggestion:** Describe it as a small middleware that verifies the header. Add the key fetch to the "who makes each AWS call" table, and add the CloudFront-only ingress rule.

**ZO-M4: Two playback mechanisms.**
- **Problem:** The README says CloudFront signed cookies on `/media/*`, but the code serves HMAC-signed `/api/files` GET through the API. The README doesn't say whether that route stays on AWS. If it does, video streams through the API containers.
- **HLS gap:** Per-file HMAC URLs can't cover HLS segments, so playback has to use cookies.
- **Suggestion:** State that `/api/files` PUT is the upload path, `/api/files` GET is for local dev only, and all playback on AWS goes through CloudFront `/media/*` cookies.

**ZO-M5: The diagram hides glue complexity.**
- **No `.sync`:** Transcribe and Rekognition Video don't have it, so each needs a poll loop or a callback.
- **Payload limit:** The Transcribe output is JSON in S3. Passing it through state data hits the 256 KB limit for long meetings and lectures.
- **No code to reshape data:** Under the no-SDK rule, that work has to happen in JSONata or intrinsic functions, or in a container.
- **Suggestion:** Add one sentence per async service on how completion is detected, and one sentence on where the transcript is turned into a prompt. The ECS task with Mountpoint is the natural place.

**ZO-M6: Who owns the status field.**
- **Two writers, two copies of SQL:** The API writes through Postgres, with migrations in `internal/db`. Step Functions writes through the Data API, with a second copy of the SQL inside the state machine.
- **Race:** Three actors change the status. A fast `failed` can be overwritten by a late `/complete`.
- **Redundant endpoint:** `/complete` isn't needed, because the upload handler already knows when the file was written.
- **Lookup:** The state machine finds the row by S3 key, so that column needs a unique index.
- **Suggestion:** Name the status transitions (uploaded → processing → ready/failed) and who owns each. Set `uploaded` in the upload handler, and say that the Data API is the reason Aurora is required.

**ZO-N1:** State why there's no SDK. Without the reason, a future reader may undo the bespoke HMAC, cookie signing and Mountpoint code as accidental complexity.

**ZO-N2:** Rekognition labels and moderation have no consumer. Tie them to a feature or defer them.

**ZO-N3:** The optional Aurora reader, customer-managed KMS keys (the bucket already uses SSE-S3), and Container Insights plus the CloudWatch agent should be labelled "later".

**ZO-N4:** The Nginx container could be an S3 origin behind CloudFront instead. The choice is stated, so it's noted only as the simpler alternative.

**ZO-N5:** The workflow text doesn't match the code. The code inserts the row on `POST /api/videos`, then the browser PUTs to `/api/files/...`, then `/complete` sets `uploaded`.

**Reuse note:** `LocalStorage` already serves both local dev and Mountpoint, with traversal guards and create-only writes. The EventBridge rule already filters on `uploads/`, so adding the state machine is one more target. The 3-day expiry on `uploads/` blocks re-processing old videos; state it if that's intended.

## Raw report: egm-inventive-catalyst

**Context check:** passed. **Verdict:** it found false compromises, mostly where the "our code never calls AWS" rule pulls against the goal of keeping heavy work off the web server. Each can be fixed without breaking the rule.

**IC-1 (Major): ffmpeg shares hosts with the API.**
- **Problem:** CPU target tracking on the API can't tell its own load from ffmpeg's.
- **Fix options:**
  - **(a)** Cut the step: use the MediaConvert image inserter for the watermark and frame capture for previews.
  - **(b)** Give ffmpeg its own capacity provider and Auto Scaling group that can scale to zero, chosen through the RunTask capacity provider strategy.
- **Liabilities:** (a) is less flexible than ffmpeg and gives no true GIF. (b) needs a second launch template, adds a cold start of a few minutes and more Terraform.

**IC-2 (Major): All upload bytes go through the API.**
- **Problem:** Files up to 5 GiB (`maxUploadBytes = 5 << 30`) flow browser → CloudFront → ALB → API → Mountpoint → S3. That is the starvation the problem statement complains about.
- **Fix:** Add a CloudFront `/uploads/*` behaviour that allows PUT to the S3 origin through OAC. Protect it with the same signed-cookie key group, with a custom policy limited to `uploads/{userID}/*`. The API still only signs a short-lived permission, and EventBridge still fires.
- **Liabilities:**
  - A single PUT tops out at 5 GB, and CloudFront's body limit needs checking. Larger files need multipart, which needs signing per part.
  - The `O_EXCL` no-overwrite protection is lost. The client would have to send `If-None-Match: *` to keep it.
  - Auth moves to a per-user cookie, and WAF body inspection is limited.
  - Local dev and the AWS upload path stop sharing code.

**IC-3 (Major): Two writers on one schema.**
- **Problem:** The Data API makes the state machine a second, untyped writer outside the migrations. It locks the design to Aurora, and nothing orders the API's status writes against the state machine's.
- **Fix:** The state machine's last step writes `results/{videoID}.json` to S3, and the failure branch writes a `failed` file. The API reads that file through Mountpoint when a video that isn't finished is viewed or listed, then updates its own row. The Data API leaves the design and any Postgres works.
- **Liabilities:**
  - Status only updates when someone views or lists the video, so the dashboard can lag.
  - The List view needs a bounded check per unfinished row, which adds read latency.
  - The reconcile code has to be written and tested.
  - The project loses a service it was meant to teach. The author decides.

**IC-4 (Major): Failures are only recorded, and the concurrency cap doesn't exist.**
- **No cap:** Standard Step Functions has no built-in concurrency cap, so a burst of uploads fans out without limit.
- **Throttling becomes failure:** Hitting a quota throws an error, for example Rekognition's concurrent-job limit, Bedrock throttling or ECS placement failures. The only handler is Catch → `failed` → email, so a burst turns into permanently failed videos.
- **Fix:**
  - Retry with exponential backoff and jitter on throttling and limit errors, before the Catch runs.
  - Use the ffmpeg capacity provider's maximum size as the real cap; tasks wait in PROVISIONING until there's room.
  - Draw the Transcribe and Rekognition Wait and Get…Job polling loops.
  - Optionally, put SQS and EventBridge Pipes in front of the state machine, so a burst has somewhere to wait.
- **Liabilities:** longer runs, more state transitions billed, less predictable behaviour under load, and another hop plus a dead-letter queue if Pipes is added.

**IC-5 (Nit):** Mountpoint only supports writing a new file in order from start to finish. ffmpeg muxers that seek back (the MP4 `moov` atom, faststart) will fail on the mount. Write to local scratch storage, then copy the result into the mount.

**IC-6 (Nit):** One NAT in AZ A means instances in AZ B lose ECR pulls if AZ A fails. State the trade-off, or add ECR interface endpoints (these bill per AZ per hour and may cost more than a second NAT).

**Notes against the other checks:**
- **Root problem:** IC-1 and IC-2 show the design partly works against its own root problem.
- **YAGNI:** The ffmpeg step and the Aurora reader are candidates to remove.
- **Reuse:** The signed-permission pattern in `LocalStorage` is the right one to extend.
- **Lock-in:** The Data API coupling in IC-3 is the main risk.
