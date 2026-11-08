# Stage 8: Intermediate Zoom Out Report

- **Target:** `README.md`, lines 1-317. The README hasn't changed since Stage 5.
- **Reviewer:** egm-zoom-out, in a fresh context. It read the Stage 5, 6 and 7 reports along with the six background files.
- **Job:** judge whether adopting the earlier findings would bloat the design, drift from the root problem, or lead to dead ends.

**Verdict:** Needs revision, but less than Stage 7 asks for. There are no Blockers and 7 Majors.
- **Why less:** applying all 29 Critic items would roughly triple the README and pin down details for parts that aren't built yet.
- **What's behind most findings:** five design decisions. Make those, and the README grows by about 30-50 lines instead of several hundred.

## The five decisions

| # | Decision | What it settles |
|---|---|---|
| 1 | **Label the target design** "Target design (not built; see Status)". Rewrite the workflow to match the code, and **delete** claims that aren't true yet ("KMS encryption", "least-privilege", "no auth code", "every call is a service integration") instead of building up to them. | C1, A3, A13, A18, A26, ZO-N5 |
| 2 | **Upload path: keep Mountpoint and add a `.done` marker.** The API writes an empty `<key>.done` file after a successful close. The EventBridge rule matches the `.done` suffix. Add one startup guard: refuse to start if the AWS data folder isn't really a mount. Don't adopt presigned or OAC uploads: hand-written SigV4 reinvents the SDK, and OAC loses the no-overwrite guard and splits local dev from AWS. Narrow the problem statement to *processing* moving off the web hosts. | A5, A6, IC-2, M8 |
| 3 | **Turn the ffmpeg step into one small Go worker**, for example `cmd/worker` in the existing image. It reads the transcript through the mount and writes the Bedrock request body to S3. Bedrock uses its S3 input and output URIs. The watermark and preview images move into MediaConvert, and the GIF is dropped. Deleting the step entirely would be a dead end, because nothing else can reshape a large transcript without the SDK. | A7, A8, IC-1, IC-5, ZO-M2, C5, C6 |
| 4 | **One Postgres function owns status:** `set_video_status(key, from_statuses, to_status, results)`, plus a unique index on `original_key`, both in the migrations. The API and the state machine (through the Data API `SELECT`) both call it. Delete `/complete` (the upload handler sets `uploaded`) and add a `processing` status. Duplicate and late writes become no-ops. Keep the Data API as a learning goal. Reject IC-3's S3 reconcile loop. | A11, M2, IC-3, C4, C9 |
| 5 | **One playback path.** On AWS, all playback goes through CloudFront `/media/*` cookies, issued by one API endpoint with Go `crypto/rsa` and the key kept in Secrets Manager. `/api/files` GET is for local dev only. The README must keep the ES256 `x-amzn-oidc-data` verification middleware and the CloudFront-only ALB rule. Cookie forwarding and the callback details belong in Terraform, not the README. | A4, A17, C2, C3, ZO-M3, ZO-M4 |

## Majors

- **ZO8-M1: the Critic's spec push is mostly bloat for a learning project.**
  - **Instead of A1:** one "Why serverful and no SDK" paragraph, which also covers ZO-N1. Write alternatives only for the two risky choices, the upload path and ffmpeg vs MediaConvert.
  - **Instead of A2:** a short "Known limits" list (single NAT, one upload path, quotas, retention).
  - **Instead of A14:** one line of idle monthly cost.
  - **Skip:** A25 (renaming sections) and latency or scale targets, which would be guesses.
  - **A16:** if you want a design doc at all, move the target sections to `docs/design.md` and keep the README as overview, status and runbook.
- **ZO8-M2:** decision 1 above.
- **ZO8-M3:** decision 2.
- **ZO8-M4:** decision 3.
- **ZO8-M5:** decision 4. Execution names built from key plus etag (part of A11) don't apply, because an EventBridge → Step Functions target can't set the execution name.
- **ZO8-M6:** decision 5.
- **ZO8-M7: search.** Either drop "find specific information" from the problem statement, or add "Postgres full-text search over transcript, summary and tags (later)". Don't design a search subsystem.

## Nits: what to adopt and what to skip

- **Adopt:**
  - **A9:** feed Transcribe an audio rendition and Rekognition an H.264 MP4, both from MediaConvert, and state a maximum length of 4 h.
  - **A10:** add Retry with backoff on throttling errors.
  - **Cheap fixes:** A20 (pin the Data API engine version; check the Bedrock model and Rekognition features exist in ap-south-1), A21 (one MediaConvert flag), A23, A24, A27 and A29.
- **Skip for now:** the SQS/Pipes buffer and a named concurrency cap (add them after a real burst), A22, the "Intelligence" rename, re-processing, and key rotation (mention it in one line).
- **A12:** say `expire-test-uploads` is a test setting. Playback after `ready` comes from `processed/`, so expiry only blocks re-processing.
- **ZO-N2, ZO-N3 and ZO-N4 still stand:** label the Aurora reader, customer-managed KMS keys and Container Insights plus the CloudWatch agent as "later". Defer Rekognition, or tie it to a moderation flag in the UI.

## Elephant fact check

- **A19, `terraform destroy`:** the reviewer says Stage 7 overstates this, because `force_destroy` defaults to false, so destroy fails on a non-empty bucket. That's correct for a bucket with files in it. **But the bucket is empty right now** (`aws s3 ls`: 0 objects), so destroy would delete it today. Adding `prevent_destroy = true` stays worthwhile; it's one line.
- **Decision 2's `.done` marker:** EventBridge does support `suffix` matching on `detail.object.key`. The state machine then has to strip `.done` to get the video key, which is one intrinsic function call. This needs to go into the Terraform and the state machine, not just the README.
- **Decision 3:** the Step Functions Bedrock `InvokeModel` integration does take `Input.S3Uri` and `Output.S3Uri`, so large transcripts can stay out of state data.

## Open trade-off for the author

Stage 5 (IC-2) and Stage 7 (A6) both say uploads through the API conflict with the problem statement. Stage 8 says to keep the upload path and narrow the problem statement instead. These two positions disagree, and it's your call. Keeping the path holds onto the no-SDK rule and the single code path. Moving uploads straight to S3 keeps upload traffic off EC2, but costs either hand-written signing or CloudFront PUT complexity.
