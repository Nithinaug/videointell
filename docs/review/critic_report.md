# Stage 7: Critic Review Report (round 1)

- **Target:** `README.md`, lines 1-317 (FeatureRange)
- **Reviewers:**
  - egm-design and egm-structural, both checked against `feature-spec-standard.md`
  - egm-style, which uses its own persona rules
- **Context:** each reviewer ran in a fresh context with the same six background files as Stage 5.
- **Reviewer status:** all 3 completed. None were left unrun.

**Verdict:** FAIL. The design and structure reviewers both returned FAIL; the style reviewer returned REVISE.

| Reviewer | Blockers | Majors | Nits |
|---|---|---|---|
| egm-design | 3 | 11 | 8 |
| egm-structural | 3 | 2 | 8 |
| egm-style | 0 | 12 | 12 |

## Consolidated action items

Finding IDs follow the pattern `<reviewer>-1-<n>`, where D = design, S = structural and Y = style. "Also in" points to the same issue in an earlier stage. ZO and IC are the two Stage 5 reviewers (see `zoom_out_report.md`), and C is the Stage 6 report (`comprehension_report.md`).

### 🔴 Blockers

| # | Action | Findings | Also in |
|---|---|---|---|
| A1 | Add an **Alternatives Considered** section, with a concrete reason each option was rejected. Cover these choices: Mountpoint vs presigned upload straight to S3; MediaConvert vs ffmpeg; Aurora provisioned vs Serverless v2 vs RDS; Cognito on the ALB vs in the app; Standard vs Express workflows; EC2 vs Fargate for ffmpeg; the no-SDK rule itself. | D-1-B1, S-1-1 | ZO-N1 |
| A2 | Add a **Risks & Mitigations** section covering failure modes, security, scaling limits and cost. | D-1-B2, S-1-2 | — |
| A3 | **Separate what's built from what's planned.** The target design is written in the present tense, but the Status list shows most of it isn't built. The upload sequence in the README doesn't match the code. | S-1-3, Y-1-M6, Y-1-M11 | C1, ZO-N5 |
| A4 | **Define the identity trust boundary.** The API has to verify the ES256 signature on `x-amzn-oidc-data`. The ALB needs a CloudFront-only rule (prefix list plus a secret header) so WAF can't be bypassed. Spell out the cookie forwarding and no-cache policy, the callback hostname, and `on_unauthenticated_request=deny` for `/api/*`. Also remove the "no auth code" claim. | D-1-B3, Y-1-M2 | ZO-M3 |

### 🟡 Majors

| # | Action | Findings | Also in |
|---|---|---|---|
| A5 | **Mountpoint safety.** A failed upload is closed, which turns it into a truncated S3 object that starts the pipeline. Deletes need the `--allow-delete` flag. If the mount is missing at boot, `MkdirAll` writes silently to EBS. List the flags, add a mount health check, and make the pipeline reject incomplete objects. | D-1-M1 | — |
| A6 | **Upload path through the API.** It conflicts with the problem statement, risks CloudFront and ALB timeouts, can lose uploads when tasks scale in, and CPU target tracking can't see it. Consider presigned PUTs straight to S3. | D-1-M2, Y-1-M1 | IC-2 |
| A7 | **ffmpeg can't write in place on Mountpoint** (MP4 needs to seek back to write the `moov` atom). Use local scratch storage, then copy, or name the output formats. | D-1-M3 | IC-5 |
| A8 | **Step Functions glue.** Add Transcribe and Rekognition poll loops or callbacks, the 256 KB payload limit (write results to S3), and the Data API through `aws-sdk:rdsdata` with its limits. | D-1-M4 | ZO-M5, C5 |
| A9 | **Service input limits.** Transcribe takes at most 2 GB and 4 h, but the API accepts 5 GiB. Rekognition needs H.264 in MP4 or MOV. A video with no speech breaks Bedrock. Feed both services MediaConvert outputs. | D-1-M5 | — |
| A10 | **Concurrency and throttling.** Name a real cap (an SQS buffer or Map MaxConcurrency), add Retry with backoff on throttling errors, and state the quota values the design assumes. | D-1-M6, Y-1-M10 | IC-4 |
| A11 | **Job correlation, idempotency and status.** Map the S3 key to the row, write the status state machine, use conditional updates, and name each execution after the key plus etag. Duplicate EventBridge events and a late `/complete` both cause races. | D-1-M7 | ZO-M6, IC-3, C4 |
| A12 | **Retention.** `uploads/` expires after 3 days, so failed jobs can't be re-run and playback links for `uploaded` videos break. State the retention period and the re-processing plan. | D-1-M8, Y-1-M8 | ZO note |
| A13 | **Claims the design doesn't back up:** least privilege (Mountpoint uses the instance role for every task), high availability (one NAT, an optional reader), "KMS encryption" (the bucket uses SSE-S3), and "all compute is EC2 we scale ourselves". | D-1-M9, Y-1-M3, Y-1-M7, D-1-N1, S-1-14 | IC-6 |
| A14 | **Cost model.** Give an idle monthly baseline, the cost per minute of video, and a Budgets threshold. | D-1-M10 | — |
| A15 | **Goals, non-goals and success criteria.** Add supported formats and maximum length, tenancy, the moderation policy, latency targets and scale. Search is raised in the problem statement but never designed. | D-1-M11, S-1-4 | ZO-M1 |
| A16 | **Split the spec from the runbook.** Status, layout, local setup and env vars are README material, not spec. | S-1-5, D-1-N7 | — |
| A17 | **Two playback mechanisms.** Say where `/api/files` is used versus CloudFront cookies, who issues the cookie, where the private key and `JWT_SECRET` live, and how keys rotate. | Y-1-M12, D-1-N2 | ZO-M4, C2, C3 |
| A18 | **Overclaims in the wording:** "every runtime AWS call is a service integration" (Mountpoint and the ECS agent are clients), "only Console and Terraform" (Docker and the CLI are also used), and "learned in the Console so apply/destroy works" (wrong cause). | Y-1-M4, Y-1-M5, Y-1-M9 | — |
| A19 | **`terraform destroy` will delete the imported video bucket.** Add `prevent_destroy`, or warn about it where destroy is run. | Y-1-M9 | — |

### 🟢 Nits

| # | Action | Findings |
|---|---|---|
| A20 | Data API on provisioned Aurora only works on certain engine versions, so pin it. Confirm the Bedrock model and Rekognition features exist in ap-south-1. | D-1-N3, D-1-N4 |
| A21 | Cap the HLS ladder at the source resolution, so low-resolution videos aren't upscaled. | D-1-N6 |
| A22 | Justify the 60% CPU target, or use request count or network as the scaling metric. | D-1-N8 |
| A23 | Diagrams: split the `uploads/` and `processed/` boxes, and line up the 2a/2b branch labels. | S-1-7, S-1-8, D-1-N5 |
| A24 | Formatting: turn the fenced workflow into a real Markdown list, tag fences as `text`, split the one-row IaC table into lists, order the Status checklist consistently, and put `localhost` URLs in inline code. | S-1-9 to S-1-13, Y-1-N10 |
| A25 | Section names: use the standard's names ("Problem Statement", "Proposed Architecture"). | S-1-6 |
| A26 | Wording: replace "as many services as fit" with the fixed list, and cut "the rule that makes this work", "managed glue", "Intelligence" and "least-privilege" (until it's true). Keep person consistent: the README uses "my", "we" and "you". Note that "CloudFront plays" should say CloudFront serves the files. Fix "No SDK anywhere" (it means in this repository). | Y-1-N1, N2, N4, N6, N7, N8, N9, N11 |
| A27 | ClimaRoute needs a link, and "the opposite way" overstates the contrast. | Y-1-N3 |
| A28 | Not everything is two-AZ (one NAT, an optional reader), and nothing says what decides "optional". | Y-1-N5 |
| A29 | List Docker as a prerequisite. Give a concrete strength rule for `JWT_SECRET` (32 or more random bytes). | Y-1-N11, Y-1-N12 |

## Traceability: raw finding to action item

**egm-design:** B1→A1, B2→A2, B3→A4, M1→A5, M2→A6, M3→A7, M4→A8, M5→A9, M6→A10, M7→A11, M8→A12, M9→A13, M10→A14, M11→A15, N1→A13, N2→A17, N3→A20, N4→A20, N5→A23, N6→A21, N7→A16, N8→A22

**egm-structural:** 1→A1, 2→A2, 3→A3, 4→A15, 5→A16, 6→A25, 7→A23, 8→A23, 9-13→A24, 14→A13

**egm-style:** M1→A6, M2→A4, M3→A13, M4→A18, M5→A18, M6→A3, M7→A13, M8→A12, M9→A18 and A19, M10→A10, M11→A3, M12→A17, N1-N2→A26, N3→A27, N4→A26, N5→A28, N6-N9→A26, N10→A24, N11→A26 and A29, N12→A29

## Things the reviewers confirmed are correct

- The Status lines for the S3 bucket and the EventBridge rule match `infra/s3.tf` and `infra/eventbridge.tf`.
- The hourly-billing warning and the 60% CPU target are concrete enough.
- The heading hierarchy, the code fences and the table column counts are all valid.
