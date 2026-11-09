# video-process: Ask box + clips + share links

* **Author:** Nithinaug
* **Date:** 2026-11-09

## Overview

The goal is a live end-to-end demo on the real AWS site for a recruiter or a friend: upload a video, watch it process, ask a question and jump to the answer, cut a clip, and share a link. The user has 10 to 30 videos, mostly 10 to 60 minutes long, a few up to 2 hours. People who open share links are teammates, a teacher or a recruiter, who are signed out and have never seen the site.

The anchored hypothesis has four parts:

- **One box.** An "Ask about your videos" box replaces "Search what was said". It searches all videos on the library page and only the current video on a video page.
- **Search.** Keyword matches appear as the user types, from the existing scan of each video's `transcript.json`. (Original idea: Postgres full-text search. Dropped for now, see Key Decisions.)
- **Ask.** Nova Lite answers only when the user presses Enter or the Ask button. The answer shows clickable timestamp sources.
- **Clips and share links.** The worker cuts MP4 clips of up to 5 minutes with ffmpeg. Share tokens are stored hashed in Aurora, can be revoked and expire. They open a read-only page with the player, chapters, summary and transcript.

The user said the problem they have today is the **wording, and not knowing what gets searched**. Speed and missed matches are not the problem.

### Reviewer status

| Reviewer | Status |
| --- | --- |
| `egm-design` | completed |
| `egm-zoom-out` | completed |
| `egm-comprehension` | completed |
| `egm-inventive-catalyst` | completed |
| `egm-codebase-details` | completed |
| `egm-structural` | completed |
| `egm-implementation-readiness` | not run (stopped by user) |

Implementation readiness did not run, so no reviewer checked these: Data API size limits, Bedrock model access on the Free plan in the target region, and whether the API task can reach `bedrock-runtime` without a NAT or a VPC endpoint. They are listed under open risks. I checked by hand the code claims this brief depends on most: the 3-day upload expiry, the 1-hour signed URL lifetime, the API's `lib/pq` driver, `SELECT *` in the store, and the `cloudfront_enabled` default.

## Analysis

### 0. The live demo may be blocked before any feature is built (Blocker, from Codebase)

`cloudfront_enabled` defaults to `false` (`infra/cloudfront.tf:1-3`). The Codebase lens reports four more facts, which I did not verify:

- The base state has no distribution.
- The app stack state is empty, so it is torn down.
- README:427 says CloudFront is waiting on AWS account verification.
- The ALB security group accepts only the CloudFront prefix list (`infra/app/app.tf:5-23`), and the Cognito callback URLs list only CloudFront domains and localhost (`infra/cognito.tf:35-36`).

If all of that holds, no public share link and no live demo works until CloudFront is up. Check this first, or plan a fallback.

### 1. The plan's biggest piece does not fix the stated problem (Blocker, from Zoom-out, Inventive, Comprehension, Codebase)

Postgres full-text search, a worker write path to Aurora and a backfill would improve speed and recall. The user said neither is the problem. The real confusion comes from the UI:

- The header box says "Search what was said" but its aria-label is "Search transcripts". It appears on every page (`frontend/src/components/Shell.tsx:41-50`).
- Pressing Enter always searches all videos, even on a video page (`Shell.tsx:24-27`).
- The results header shows only the query (`frontend/src/pages/Search.tsx:47`).
- Videos that are still processing are skipped without telling the user (`backend/internal/handlers/videos.go:119`).
- Only spoken lines are searched.

A scope label and clearer copy fix this without any backend change. The video page already loads the whole transcript (`frontend/src/api/client.ts:124-137`), so "search this video" can filter in the browser with no API call.

### 2. The one real reason for better retrieval is Ask, not typing (Major, from Zoom-out, Design, Codebase, Structural)

Today's matching (`containsAll`, `videos.go:96-104`) requires every word to be a substring. A question like "what did they say about deadlines?" matches nothing, so Ask would get no context. Plain `plainto_tsquery` has the same problem, because it also requires all terms. Full-text search also matches whole words only, so typing "recur" stops matching "recursion". The `english` configuration handles poorly the Hindi and other non-English videos that whisper's `-l auto` produces (`worker.go:370`). Proposed split:

- **Typing:** keep substring semantics. Over a table this is `ILIKE '%term%'` per term. Over a cache it is today's `containsAll`. At tens of thousands of lines it needs no index.
- **Ask on one video:** skip retrieval and send the whole transcript. A 2-hour transcript is under `maxTranscriptChars = 300_000` (`worker.go:19`) and roughly 20-30k tokens.
- **Ask across the library:** sending all of it does not fit (30 videos at up to 2 hours is several million characters). Use OR matching with stopwords dropped (for example `to_tsquery('decide | pricing')` with `ts_rank`), take the top 20-40 lines with neighbours, and add each video's summary.json. The Inventive lens suggests another option: the model first picks videos from the summaries, then reads those full transcripts.

### 3. Where transcript data lives (Major, open decision with a real split)

All six reviewers agree that S3 `transcript.json` stays the canonical copy. Anything in Aurora is a derived index that can be rebuilt (Structural Blocker #2). The panel, captions and future exports keep reading S3. They disagree on what builds the index:

- **No table (Zoom-out, Inventive):** keep the S3 scan, debounce typing, and add an in-process cache keyed by output prefix if timing shows the scan is slow. transcript.json never changes once a video is ready. At 30 videos the cache is a few MB in one 512 MB task (`infra/app/app.tf:147-149, 233`). No migration, no backfill, no IAM change.
- **Lazy ingest by the API (Design, Codebase):** the API already owns the tables, already reads transcript.json through Mountpoint (`videos.go:126-140`), and connects with `lib/pq` (`backend/internal/db/iamauth.go:113`). On first need, it replaces a ready video's lines in one transaction. One code path covers new videos and the backfill, with no worker, IAM or grant changes.
- **A worker `index` op in the pipeline (Structural):** a new `IndexTranscript` state after `Process` calls one SQL function, `replace_transcript(key, segments JSONB)`, through the Data API. Its own Catch continues to Summarize, so an indexing failure never fails the video. The backfill is the same op run once per ready video. Structural prefers this because lazy ingest ties searchability to the app stack, which gets torn down. The cost is new worker IAM (`rds-data`, `secretsmanager`, `s3:GetObject processed/*`), a guarded grant, and an unverified Data API payload limit for a 300 KB JSONB parameter.

All reviewers reject the hypothesis's version, where Assemble writes the rows. The worker has no Aurora access today (`infra/lambda.tf:50-65`, no cluster or secret env at `:82-84`). The `pipeline` role has only `SELECT, UPDATE ON videos` (`infra/db-setup.sql:10-11`). Assemble is retried (`infra/stepfunctions.tf:35-41, 137`), so it could insert duplicates, and a Data API error there would mark a good video as failed.

If a table is used, three more points apply:

- An "indexed?" marker is needed, because a video with no speech legitimately has zero lines. Structural proposes a parent `transcripts(video_id PK, indexed_at, line_count)` table rather than a new `videos` column (see section 4).
- `videos.results` is not a safe place for the marker, because `set_video_status` overwrites `results` (`0002_video_status.sql:11`).
- Index the `text` column under one named text-search configuration and record the language limit.

**Correction to the hypothesis:** the API does not use the Data API. It connects with `lib/pq` and a hand-signed IAM token. Only Step Functions uses the Data API.

### 4. Schema changes carry two rollback traps (Blocker, from Structural, Codebase, confirmed in code)

- **`SELECT *` into a fixed struct.** `store.go:45` and `:56` use `SELECT * FROM videos` with sqlx into `models.Video`, and sqlx fails on any column that has no struct field. So adding any column to `videos`, and then rolling back to the previous image, breaks List, Detail, Delete and Search. Migrations never run down, so the image is the only rollback. Fix: explicit column lists before any schema change, or put new data in new tables with `REFERENCES videos(id) ON DELETE CASCADE`.
- **Migrations re-run on every boot.** There is no version table and no transaction (`backend/internal/db/db.go:24-46`). With one task and minimum healthy percent 0 (`app.tf:290-293`), one statement that cannot run twice takes the site down. Rules for this batch:
  - Use only `IF NOT EXISTS` and `CREATE OR REPLACE` forms.
  - Put no data movement in SQL.
  - Wrap grants to `pipeline` in a `DO` block that checks the role exists, because local Postgres has no `pipeline` role.
  - Keep migrations additive only (no DROP, RENAME or type change).
- `db-setup.sql` does not include 0003 (`infra/db-setup.sql:5-6`). Freeze it as bootstrap only, and keep API boot as the single schema owner.
- When a stage touches both Terraform roots, apply app (the migration) before base.

### 5. The "?" auto-trigger hides a mode switch and spends credits (Blocker for UX, from Comprehension, Inventive, Design, Zoom-out)

With live matching, typing "?" fires a paid Bedrock call while the user is still editing. Someone who asks without "?" never finds out Ask exists. Recommended instead:

- Typing always shows keyword matches.
- Ask runs only on Enter or a visible button whose label states the scope ("Ask about all 23 videos" / "Ask about this video").
- A trailing "?" may highlight the button but never fires a call.
- A scope chip sits in the box.
- When a question gets no keyword matches, the empty state says "No exact word matches. Press Enter to ask."

### 6. Grounded answers: the model must not write timestamps (Major, from Inventive, Design, Comprehension, Codebase)

- Send each line with an id like `L17`.
- Require JSON back: `{answer, sources:[ids]}`.
- The server maps ids back to `(video_id, from_ms)` and drops any id it did not send.
- If no valid source remains, show "I couldn't find that in [scope]".
- Reuse the code-fence stripping used for summaries (`infra/stepfunctions.tf:219`).
- If Bedrock fails, return the keyword matches with no answer, never a 500.
- Chapters are already LLM-written `{start, title}` with no end time (`worker.go:409-411`). Snap starts to the nearest segment and validate them.

### 7. Calling Bedrock from the API without the SDK (Major, from all completed lenses)

`presign` (`iamauth.go:67-106`) is query-string only. It hard-codes GET, signs only `host`, and uses the raw path. Bedrock Converse needs a header-signed POST with a body hash and the security token. The model id `apac.amazon.nova-lite-v1:0` has a colon, so the canonical URI must encode each segment twice (`%253A`). This is a common cause of SigV4 failures. Needed:

- Move `loadCreds`, `sha256Hex` and `hmacSHA256` into one small shared signer, with a header-signing test against a published AWS vector next to `iamauth_test.go:10`.
- Use non-streaming Converse.
- Add `bedrock:InvokeModel` to the API task role, which has only `rds-db:connect` (`app.tf:198-209`). Mirror the ARNs at `stepfunctions.tf:350-356`, and export the profile from base outputs so there is one value.
- Set the HTTP client timeout under 60 s. `loadCreds` uses `http.DefaultClient`, which has no timeout (`iamauth.go:35`). CloudFront's origin timeout is 60 s (`infra/cloudfront.tf:44`), and the Codebase lens says the ALB keeps its 60 s default idle timeout.
- README:23-27 ("Our code makes no AWS API calls") becomes false and must be updated.

### 8. Clips have no lasting source except HLS (Blocker, from Design, Codebase, Structural, confirmed in code)

`infra/s3.tf:62-75` deletes `uploads/` after 3 days. The Lambda worker writes no MP4; README:392 is stale. The only lasting source is the HLS renditions. Those are 30 s chunks encoded separately with `-reset_timestamps 1` and `#EXT-X-DISCONTINUITY` between chunks (`worker.go:99-103, 248-250`). Requirements:

- Read the rendition's `index.m3u8` and pick the overlapping `.ts` segments from the `#EXTINF` durations. Share that parsing with Assemble (`worker.go:251-261`).
- Join the segments with the concat demuxer, which shifts each file's timestamps, then `-ss`/`-t` and a re-encode to MP4. Do not use ffmpeg's HLS reader across the joins.
- Grant the worker `s3:GetObject` on `processed/*`. Today it has only `uploads/*` and `work/*` (`lambda.tf:56-59`).
- ffmpeg is in the worker image, not a layer (`backend/Dockerfile.worker:21-29`). 10 GB of memory and a 900 s timeout are enough.
- Video duration is not stored anywhere. Chapter end = next chapter's start, and the last chapter needs the summed `#EXTINF` durations. Store the duration in `results` at MarkReady by merging, not overwriting. Clamp chapters to the 5-minute cap.

Reviewers disagree on how much a "clip" needs to be:

- **Zoom-out:** a time range inside the share token, played on the existing HLS.
- **Inventive:** a sub-playlist that plays instantly, plus an MP4 made only when the user clicks Download.
- **Design, Codebase, Structural:** a real MP4.

The demo script ("cut a clip") most likely means a real file. Comprehension rated it a Blocker that the brief does not say whether a share link can point at a clip.

Triggering a clip job from the API with no SDK has two options:

- **Marker plus EventBridge (Codebase, Inventive, Structural).** The API writes a marker through Mountpoint. Keep it out of `uploads/` and do not name it `*.done`, or it starts the pipeline (`infra/eventbridge.tf:5-12`).
- **Signed async Lambda Invoke (Design).**

Status comes from whether the output file exists, as `Progress` does today (`videos.go:193-200`). Structural warns that a plain async invoke that dies leaves the clip "pending" forever. With a Delete guard on pending clips, that video could then never be deleted. Two remedies:

- A small clip state machine with a Catch that marks the clip failed.
- At minimum, a Delete guard that ignores pending clips older than the Lambda timeout plus a margin, and an on-failure destination that writes `clip.error`.

Store clips under the video's processed prefix, so Delete's RemoveAll (`videos.go:166-170`) cleans them up.

### 9. Share links cannot reuse today's signed folder URL (Blocker, from all completed lenses, confirmed in code)

`DirURL` (`backend/internal/storage/local.go:46-49`) signs the whole processed prefix for 1 hour (`local.go:21`). That causes four problems:

- **Revocation is late.** A URL that was already handed out keeps working for up to an hour.
- **The scope is too wide.** It covers labels.json, bedrock-request.json, progress.json and every clip, and it puts the owner's user UUID in the path.
- **Directories can be listed.** `c.File` (`videos.go:316-334`) lists directories. This already affects owners.
- **Long videos stop playing.** HLS segments start returning 403 after an hour, partway through a 2-hour video, and `VideoDetail` never fetches a new URL. This already affects owners.

How the share token should be stored is an open decision:

- **Aurora `shares` table plus a proxy route (Design, Structural, Codebase).** The table stores `sha256(token)`, `expires_at` NOT NULL with a cap, `revoked_at`, and an FK cascade to videos. `GET /api/s/:token/*file` checks the token on each request (cached about 30 s) and serves an allowlist only. A clip share returns only `PlaybackURL(clipKey)`, served with Range support (`videos.go:303-314`).
- **S3 object per share (Inventive).** The signed-out path never touches Aurora, which auto-pauses after 300 s (`infra/database.tf:21-25`). Resume takes about 15 s per walkthrough:748-751. Revoking means deleting the object.
- **Stateless HMAC token plus `share_version` (Zoom-out).** Revoking means bumping the version, which revokes all links for that video at once. It needs a `videos` column, so the `SELECT *` fix in section 4 comes first.

Whichever is chosen, the share page needs:

- **Frontend:**
  - The route outside ProtectedRoute (`frontend/src/App.tsx:12-19`).
  - Plain `fetch` instead of the shared axios instance, which sends any 401 to Cognito (`client.ts:17-23`). Use 404 or 410 for bad tokens.
  - Its own frame instead of Shell, reusing `Watch` (`VideoDetail.tsx:231-317`) with the Tags and "Seen in the video" cards hidden.
  - One friendly page for expired, revoked, malformed and deleted links.
  - If tokens are hashed, a "copy it now" note when the link is created.
- **Backend:**
  - Tokens of 32 bytes from `crypto/rand`.
  - `Referrer-Policy: no-referrer`.
  - A refusal to share videos that are not ready.
  - **The token kept out of logs (Major, from Codebase).** `gin.Default()` (`backend/internal/router/router.go:16`) logs every path to CloudWatch, which would store the raw token in plain text and defeat the hashing. Redact `/api/s/*` paths or send the token in a header.

### 10. Cost guardrails and observability (Major, from Design, Zoom-out, Inventive, Codebase)

- Cognito self sign-up is open (`infra/cognito.tf:1-18`). The $25 budget only sends alerts (`infra/ops.tf:30-57`). Add in-memory per-user limits, which work because there is one task: for example 30 Asks per hour and 3 clips in progress.
- Log one line per Ask: user, scope, input and output tokens (Converse returns `usage`), latency and outcome. Return 429 or 503 on throttling.
- Log `op`, `videoKey` and clip id at the start and end of the worker's clip op. Write `clip.error` with a message.
- `UpsertCognitoUser` writes to the database on every request (`handlers/middleware.go:25`). With type-ahead that becomes a write per keystroke, so cache it in memory.
- Rough cost estimates, not checked against current pricing:
  - Ask about one 1-hour video: about $0.001. Worst case, about $0.005.
  - One MP4 clip: about $0.01 of Lambda.

### 11. Smaller items (Nit)

- Fewer than 2 characters returns nothing (`videos.go:108`). Show "Keep typing..." instead.
- On a video page, a source click should seek and scroll the player into view, respecting reduced motion.
- The delete confirmation should mention that it also removes clips and share links.
- Wake Aurora up before the live demo.
- Doc drift:
  - README:36 and README:368 describe CloudFront cookie signing that does not exist.
  - README:370 says "No SDK in this repository", but the worker uses SDK v2.
  - The `docs/walkthrough.md:33-41` diagram shows the old worker.
  - README:290-292 says the pipeline would fill full-text search.

### Ideal Final Result (synthesized)

Ask, clips and shares run on files the pipeline already makes: transcript.json, summary.json and the HLS segments. S3 stays the canonical copy of every transcript. The only new costs are one Bedrock call per explicit, labelled Ask and one Lambda run per real clip. Nothing new is billed by the hour. What a link gives access to is exactly what the owner meant to share, revoking takes effect within seconds, and the raw token never lands in a log.

## Goals vs. Non-Goals

* **In-Scope Goals:**
  * Build and test in local hybrid mode (laptop API with real Aurora and S3) and record the demo there. CloudFront is a separate later step, not part of this spec.
  * Scope-labelled box: placeholder "Search what was said in your videos", a scope chip ("All videos" / "This video"), and a results header that states what was searched. Processing videos named as not yet included.
  * Keyword matches as the user types, with a debounce and substring semantics, from the current transcript scan. No index.
  * Ask on Enter or a button only, with a scope-labelled answer card and server-validated sources.
  * Clips of up to 5 minutes cut from processed HLS, never `uploads/`, with cutting, ready and failed states that cannot get stuck.
  * Revocable, expiring share links that open a signed-out, read-only page through a path that checks the token and allows only listed files. The token never appears in logs.
  * A shared SigV4 header signer with a test.
  * Per-user rate limits on Ask and clips.
  * Fix directory listing and the 1-hour TTL problem for long videos.
  * Replace `SELECT *` before any schema change.
* **Out-of-Scope Non-Goals:**
  * SRT/VTT/TXT/MD exports, action items and decisions, collections and filters, speaker labels. Structural notes the S3-canonical layout leaves room for these without rework.
  * Searching titles, tags and visual labels. The UI must say that only speech is searched.
  * Vector search and embeddings.
  * Streaming Ask answers.
  * Any new hourly-billed resource: no NAT, no VPC interface endpoints, no CloudFront signed-URL infrastructure.

## Alternatives Weighed

* **Assemble writes transcript lines to Aurora.** Rejected by all reviewers. The worker has no Aurora access, Assemble is retried and could insert duplicates, and a database error would fail a good video. A separate backfill would still be needed. A separate worker `index` op with a continue-on-error Catch remains a live option (section 3).
* **Postgres full-text search for type-ahead.** Rejected by reviewers. It matches whole words only, requires all terms, and handles non-English videos poorly. Kept as an option for ranking Ask retrieval only.
* **Auto-firing Ask on a trailing "?".** Rejected by reviewers. It is a hidden mode switch that spends credits.
* **Cutting clips from the original upload.** Rejected. Uploads are deleted after 3 days.
* **ffmpeg's HLS reader or `-c copy` straight across chunk joins.** Rejected. Discontinuity timestamps break it. Use the concat demuxer plus a re-encode.
* **Reusing `DirURL` / `results_url` for share viewers.** Rejected. It revokes late, its scope is the whole prefix, it exposes directory listings, and it puts the owner's UUID in the path.
* **CloudFront signed URLs or S3 presigning for share media.** Rejected. It adds infrastructure, still revokes late, and none of that infrastructure exists today.
* **New columns on `videos` before fixing `SELECT *`.** Rejected. Rolling back the image would break reads.
* **Adding `\i` lines to `db-setup.sql` for new tables.** Rejected. API boot is the schema owner.
* **Bedrock ConverseStream.** Rejected for now because of its binary event-stream format.
* **The shared axios instance on the share page.** Rejected. A 401 would send signed-out viewers to Cognito.

## Key Decisions & Staging for Next Steps

Decided by the author (2026-11-09):

1. **Demo hosting.** CloudFront is stuck on the AWS account check and nothing on the author's side speeds it up. Build, test and record the demo in local hybrid mode. A live demo to a recruiter on the real site waits for CloudFront. A share link opened from another machine will not work until the API is publicly reachable, so the recorded demo shows the share page in a second signed-out browser on the laptop.
2. **Transcript index.** None for now. Scanning `transcript.json` is fast enough for 10 to 30 videos. Add Postgres full-text search only if it gets slow. S3 stays canonical.
3. **Ask trigger.** Enter or the Ask button only. The trailing "?" rule is dropped.
4. **Staging of the box.** Step one is wording and scope labels only. Step two is Ask on top of the current transcript scan.
5. **Share links.** Their own signed URLs that refresh while the page is open, plus a `share_links` table row so a link can be cancelled before it expires.
6. **Clips.** Cut from the processed HLS segments, never `uploads/`. The worker gets read access to `processed/*`.
7. **Schema safety.** Replace `SELECT *` with named columns in the same change that adds a new column.
8. **Bedrock route.** Check that the API task can reach Bedrock, and that permissions work, before building Ask. If it cannot do so cleanly, run Ask in a small Lambda instead.
9. **Constraint correction.** The API uses `lib/pq` with an IAM token. Only the pipeline uses the Data API.

Still open for `/egm:egm-draft`:

- **What a clip is.** A range in a share link, a sub-playlist with an on-demand MP4, or an MP4 re-encoded right away. And whether a share link can point at a clip.
- **Clip trigger and failure handling.** Marker plus EventBridge or a signed async invoke, and a small state machine or a stale-pending timeout.
- **Library-wide Ask retrieval.** With no index, which transcript lines go to Nova Lite: ranked keyword lines plus summaries, or summaries first. A 30-video library will exceed a sensible prompt size, so a cap is needed.
- **Refreshing share URLs.** How the share page asks for fresh signed URLs, and how often.

Suggested staging, each stage shippable on its own with the site working between stages:

0. **Prep.** Confirm local hybrid mode runs against real Aurora and S3. Check the Bedrock route from the API task. Replace `SELECT *`. Move the SigV4 signer into its own package with a test. Freeze `db-setup.sql`. Fix directory listing.
1. **Wording and scope.** Copy changes, the scope chip, a `video_id` param on the existing search, a video-page filter in the browser, and empty and processing states. This fixes the stated problem.
2. **Ask.** Bedrock IAM on the API task role, `POST /api/ask` with id-based sources, rate limits and Ask logging. Add the transcript index from decision 2 only if timing or recall on the real site demands it.
3. **Share links.** Token storage, an unauthenticated route that allows only listed files, token redaction in logs, a minimal share page, one page for dead links, and the TTL fix. This depends only on stage 0.
4. **Clips.** A worker `op: "clip"` reading HLS from `processed/*`, the trigger path, file-based status that cannot get stuck, and a 5-minute cap enforced on the server.

Open risks to check before drafting. Implementation readiness did not run, so no reviewer covered these:

- Whether the API task can reach `bedrock-runtime` and the Lambda API without a NAT or a VPC endpoint. A VPC interface endpoint would be billed by the hour.
- That Nova Lite and the `apac` inference profile are available on the Free plan in the target region. Use a harmless read call plus `aws freetier get-account-plan-state`.
- Data API request and parameter size limits, if the worker `index` op is chosen.
- How long Aurora takes to resume on the signed-out share path.
