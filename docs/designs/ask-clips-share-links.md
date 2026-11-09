# video-process: Ask box, clips and share links

*   **Author:** Nithinaug
*   **Status:** Draft
*   **Date:** 2026-11-09

--------------------------------------------------------------------------------

## Overview

video-process turns an uploaded video into HLS streams, a transcript, chapters,
a summary and tags. This design adds three things on top of those files:

1.  A search box that says what it searches, and an Ask action that answers a
    question from the transcripts and links to the moments it used.
2.  Short clips (at most 5 minutes), saved as a start time and an end time on a
    video and played on the existing HLS stream. A clip is not a new file.
3.  Share links that let a signed-out person watch one video, read-only, and that
    the owner can cancel.

The work is built and tested in local hybrid mode: the API runs on the author's
laptop and talks to the real Aurora database and the real S3 buckets. The demo
is recorded in that mode. Turning on CloudFront is a separate step and is not
part of this design.

## The Problem

**Search.** The top bar shows "Search what was said". It gives no hint that it
searches spoken words across all of the author's videos. Pressing Enter on a
video page still searches every video. The results page shows only the query
text and does not say what was searched. Videos that are still processing are
skipped without a message. Speed and missed matches are not the problem.

**Questions.** A keyword box cannot answer "what did they decide about
deadlines?". The reader has to open several videos and look.

**Sharing.** There is no way to show a video to a teammate, a teacher or a
recruiter without giving them an account. The existing signed folder URL cannot
be used for this: it covers the whole processed folder (the Bedrock
request, progress files), it lasts one hour so a cancelled link keeps working,
and it stops long videos from playing after an hour.

**Clips.** There is no way to mark and revisit a short piece of a video, or to
point someone at it. The author chose to store a clip as a time range and play it
on the existing HLS stream, so no worker job and no new file are involved.
Playback can start up to one 30-second chunk before the saved start time, because
HLS starts on chunk edges.

The proposed solution: relabel the box and add a scope chip (step one), add Ask
on top of the current transcript scan (step two), add clips as saved time ranges,
and add share links backed by a `share_links` table row and their own refreshing
signed URLs.

## Goals

*   The search box says what it searches. The placeholder reads "Find a moment:
    type words someone said" (shipped). A chip shows "All videos" or "This video". The results
    header states the scope and the query. Processing videos are named as not yet
    included.
*   On a video page the box searches only that video. On the library page it
    searches all of the user's ready videos.
*   Keyword matches appear while the user types, with no AI call.
*   Ask runs only when the user presses Enter or the Ask button. The answer is
    shown above the matches. Each source is a clickable timestamp that comes from
    a transcript line the server sent to the model, never from text the model
    wrote. If no valid source remains, the page says it could not find the answer
    in that scope. If the model call fails, the keyword matches are still shown.
*   The API can reach Bedrock before Ask is built (confirmed for the laptop and
    the ECS subnets). If a check fails, stop and re-plan; no Lambda fallback is
    designed.
*   A user can save a clip of at most 5 minutes from a time range or a chapter. The
    clip is a stored start and end time that plays on the existing HLS stream. The
    5-minute cap and the check that start is before end and inside the video are
    enforced on the server. Deleting a video deletes its clips.
*   A share link always points at a whole video. On the share page a clip is shown
    as a bookmark that opens the player at the clip's start time.
*   A user can create a share link for a ready video. A viewer who is not signed
    in sees the player, chapters, summary and transcript, read-only. There is no
    search, no Ask and no delete.
*   The owner can cancel a link before it expires. For a cancelled or expired link,
    the API refuses new page loads and URL refreshes at once. Video that is already
    playing stops within 5 minutes, when its last signed URL runs out. The raw
    token is not stored and does not appear in logs.
*   The share page asks for fresh signed media URLs every 4 minutes while it is
    open, so a 2-hour video plays to the end.
*   New columns or tables do not break a rollback to the previous API image.
*   The author can record one run on the local hybrid setup: upload, watch it
    process, ask a question and jump to the answer, save a clip, open a share link
    in a signed-out browser, cancel the link.

## Non-Goals

*   Postgres full-text search, a transcript index in Aurora, a worker write path
    to Aurora, and a backfill. Add them only if scanning `transcript.json`
    becomes slow.
*   SRT, VTT, TXT and Markdown exports; action items and decisions in the summary;
    collections and library filters; speaker labels.
*   MP4 clip files, a worker clip job, downloading a clip, and worker read access to
    `processed/*`. Chosen by the author on 2026-11-09 instead of the earlier plan to
    cut MP4s from HLS segments.
*   Share links that point at one clip or limit the viewer to a range. Any viewer
    of a link can fetch the whole video.
*   Searching titles, tags or visual labels. The page must say that only speech is
    searched.
*   Vector search and embeddings.
*   Streaming Ask answers.
*   Turning on CloudFront, and opening the API to the public internet. Because of
    this, a share link cannot be opened from another machine in this phase.
*   Any new resource billed by the hour: no NAT Gateway, no VPC interface
    endpoints, no CloudFront signed-URL infrastructure.
*   The AWS SDK in the API. The API signs requests itself with the standard
    library.

## Open Questions

*   **Bedrock route: resolved.** The API instances run in public subnets with
    public IPs and an internet gateway (`infra/network.tf:24`, `:34`), so they
    reach Bedrock without a NAT. The pipeline already calls
    `apac.amazon.nova-lite-v1:0` from ap-south-1 on the Free plan. Remaining work:
    grant the API task role `bedrock:InvokeModel` on that profile and its models,
    and sign the call with the existing SigV4 code in `backend/internal/db/iamauth.go`.

## Critical User Journeys (CUJs)

### CUJ 1: Find a moment in a video or across the library

*   **Given**: The author is signed in and has ready videos. Some videos are still
    processing.
*   **When**: They type "deadline" in the box on the library page, then on a video
    page. Later they type "what did they decide about the deadline" and press Enter.
*   **Then**: On the library page the chip reads "All videos" and matches appear
    as they type, under a header such as `Spoken words in 23 videos matching
    "deadline"`, with a line naming the 2 videos still processing. On a video page
    the chip reads "This video" and the matches come from that video's transcript.
    Pressing Enter shows an answer card above the matches. Each source is a
    timestamp; clicking it opens that video at that time. If the model call fails,
    the matches still show, with a note that the answer was not available.

### CUJ 2: Save a clip

*   **Given**: The author is watching a ready video.
*   **When**: They set a start and end (from the current play position or from a
    chapter) and save the clip.
*   **Then**: The clip is listed under the player. Playing it seeks to the start and
    pauses at the end. A range over 5 minutes, or one that ends before it starts,
    is refused with a message.

### CUJ 3: Share a video and cancel the link

*   **Given**: The author has a ready video.
*   **When**: They create a share link with an expiry of 1, 7 or 30 days, copy it,
    and open it in a browser that is not signed in. Later they cancel it.
*   **Then**: The viewer sees the player, chapters, summary, transcript and clip
    bookmarks. There is no search, Ask or delete. Playback continues past one hour
    because the page refreshes its URLs. After the author cancels, reloading the
    link shows a single "link not available" page, and playback in an open tab stops
    within 5 minutes.

## Technical Plan (Architecture)

The API keeps serving files from the S3 mount through `LocalStorage` and keeps
signing its own URLs. Nothing in the API uses the AWS SDK. Three new pieces sit
beside the existing routes:

```text
Browser (owner)                          Browser (viewer, signed out)
  |  Bearer JWT                            |  header X-Share-Token
  v                                        v
/api/search?q=&video_id=      /api/share-view  -> {title, base URL, clips}
/api/ask                      /api/share-files/:exp/:sig/*key  (allowlist)
/api/videos/:id/clips[/:cid]
/api/videos/:id/shares[/:sid]
  |                                        |
  +------------- Go API (laptop now, ECS later) -----------+
        |                |                       |
   Aurora (lib/pq)   S3 mount (transcript.json,  Bedrock Converse
   clips, share_links  summary.json, hls/*)      (SigV4 headers, stdlib)
```

### 1. Search box wording and scope (step one, front end plus one query parameter)

*   **Already shipped** (do not rebuild): the top-bar box has a search icon, the
    placeholder "Find a moment: type words someone said", the aria label "Search the
    spoken words in all your videos" and a matching tooltip (`Shell.tsx`). The results
    page shows the line "Moments where this was said, across all your videos (N).
    Click one to play from there." and the empty state "Nobody says that in any of
    your videos. Try fewer or different words." (`Search.tsx`). A failed request
    shows an error instead of loading forever.
*   **Still to build**: a scope chip next to the box. It shows "This video" on a
    video page and "All videos" elsewhere, and the author can switch it. The
    results line names the scope instead of always saying "all your videos".
*   `GET /api/search` always scans all the caller's ready videos (a video page
    filters its own transcript in the browser, so search needs no `video_id`). The
    response gains `searched` (how many ready videos were scanned) and `skipped`
    (titles of videos not ready yet), so the results line can say what was searched
    and name the videos still processing.
*   On a video page the already-loaded transcript is filtered in the browser, with
    no request.
*   Search and library-wide Ask read each video's transcript through one function,
    `loadTranscript(prefix)`, with no cache: it reads `transcript.json` from the S3
    mount on every call. The author chose this; add a cache only if type-ahead is
    slow.
*   Typing triggers a request after a 300 ms pause. The matching rule is unchanged
    (every word must appear in the line, as a substring). Under 2 characters the box
    shows "Keep typing...".
*   The authentication middleware writes the user to Aurora on every request. With
    typing, that becomes many writes, so the middleware remembers the user id for
    each Cognito `sub` in memory for 10 minutes.

### 2. Ask (step two)

*   **Route**: `POST /api/ask` with `{q, video_id?}`, behind the existing auth. It
    runs only from Enter or the Ask button, whose label names the scope.
*   **Bedrock call**: a new `internal/awsapi` package signs a Bedrock Converse request
    with SigV4 headers using only the standard library. The credential loading and
    hashing helpers move there from `internal/db/iamauth.go`, so the database code and
    Bedrock share one signer. The model identifier has a colon, so the canonical path
    encodes it twice. The HTTP client has a 45 second timeout, below the 60 second
    limit of the edge in front of the API. The model and region come from
    configuration; the default model is `apac.amazon.nova-lite-v1:0`, the profile the
    pipeline already uses. The call is not streamed.
*   **Choosing what to send**:
    *   One video: every transcript line of that video, plus its summary. The text is
        cut at the existing 300,000 character limit and the answer says so if it was
        cut.
    *   All videos: take the question's words, drop common English words and words
        shorter than 3 letters, and keep lines that contain any remaining word.
        Score each line by how many different words it contains. Take the top 30 lines
        with one line either side, capped at 12,000 characters, plus the summaries of
        at most 5 videos those lines came from. If no line contains any word, no
        model call is made and the page says no transcript line shares a word with the
        question.
*   **Grounding**: each line is sent with an id (`L1`, `L2`, ...). The model must
    return JSON `{answer, sources: [ids]}`. The server maps each id back to
    `(video_id, from_ms)`, discards ids it did not send, and returns the answer only if
    at least one valid source remains. Otherwise it returns "I couldn't find that in
    [scope]". Code fences around the JSON are stripped, as the summary step already
    does. The model never writes a timestamp that reaches the page.
*   **Failure**: a Bedrock error, timeout or throttle returns the keyword matches with
    no answer and a note, with status 200, not a 500.
*   **Limits and logs**: an in-memory counter allows 30 Asks per user per hour (there
    is one API task). Each Ask logs one line: user id, scope, input and output tokens
    from the Converse `usage` field, latency and outcome.
*   **Gate before building**: the first task is to check that the API can reach
    Bedrock and has permission, from the laptop in local hybrid mode and from the ECS
    task role (`bedrock:InvokeModel` on the same profile and model ARNs the pipeline
    uses), without a NAT Gateway or VPC endpoint. If a check fails, stop and re-plan.

### 3. Clips (saved time ranges)

*   New table `clips (id, video_id, start_ms, end_ms, title, created_at)`, with
    `video_id` referencing `videos` and deleting with it.
*   Routes under `/api/videos/:id/clips`: create, list, delete. The server checks that
    the video belongs to the caller and is ready, `start_ms >= 0`, `start_ms < end_ms`,
    `end_ms - start_ms <= 300000`, and `end_ms` is not past the end of the video. The
    video length is the sum of the `#EXTINF` durations in its HLS playlist; it is not
    stored today.
*   The player plays a clip by seeking to `start_ms` and pausing at `end_ms`. Because
    HLS starts on chunk edges, playback can begin up to one 30 second chunk early and
    the player corrects it by seeking after the stream loads.
*   Chapters in `summary.json` have a start time only. A chapter's end is the next
    chapter's start, or the end of the video for the last one, cut to 5 minutes.

### 4. Share links

*   New table `share_links (id, video_id, token_hash, created_at, expires_at,
    revoked_at)`. `token_hash` is unique and holds the SHA-256 of the token.
    `expires_at` is required. `video_id` references `videos` and deletes with it.
*   **Create**: `POST /api/videos/:id/shares {days}` with `days` of 1, 7 or 30
    (default 7), only for the owner and only for a ready video. The token is 32 random
    bytes from `crypto/rand`, URL-safe encoded, returned once with the page link
    `/share/<token>`. Up to 10 active links per video.
*   **Cancel and list**: `GET /api/videos/:id/shares` lists links (created, expiry,
    state, never the token). `DELETE /api/videos/:id/shares/:sid` sets `revoked_at`.
*   **Viewer access, with no sign-in**:
    *   `GET /api/share-view`, with the token in the `X-Share-Token` header, hashes it
        and finds a row that is not revoked and not expired, for a video that still
        exists and is ready. Otherwise it returns 404 for every failure, so a viewer
        cannot tell which case it was. On success it returns the title, a signed base
        URL for the video's processed folder valid for 5 minutes, and the clip list.
        The token goes in a header, not the URL path, so the API's request log never
        contains it. The response sets `Referrer-Policy: no-referrer`.
    *   `GET /api/share-files/:exp/:sig/*key` serves media. The signature uses a new
        scope, `SHARE`, so an owner's folder URL cannot be used here and the reverse. The
        handler serves only regular files that match: `summary.json`,
        `transcript.json`, `transcript.vtt` (the player's captions track),
        `thumbs/thumb_<number>.jpg` (the player's poster), `hls/master.m3u8`,
        `hls/<rendition>/index.m3u8` and `hls/<rendition>/c<number>_<number>.ts`. It
        refuses directories, `labels.json`, `bedrock-request.json` and `progress.json`,
        and it supports range requests.
*   **Refresh**: the share page calls `/api/share-view` again every 4 minutes. With
    hls.js, a request hook rewrites the signed part of each segment URL to the newest
    base, so the stream continues without reloading. Browsers that play HLS natively
    (no hls.js) get the new base by setting the source again and seeking to the saved
    position, which can cause a short stall.
*   **Page**: a route `/share/:token` outside the sign-in guard, using plain `fetch`, not
    the shared axios client, because that client sends any 401 to the Cognito login.
    It has its own frame instead of the app shell, and shows the player, chapters,
    summary, transcript and clip bookmarks (the app no longer has Tags or labels
    cards). Expired, cancelled, deleted and malformed
    links all show one "link not available" page.
*   **Owner screen**: on the video page, a Share panel to create a link (choose 1, 7 or
    30 days), copy it (shown once), see existing links and cancel them. The delete
    confirmation says that clips and share links are removed too.
*   **Known limit**: the signed path contains the owner's user id and the video id
    (`processed/<user>/<video>/`). These are not secrets, but a viewer can see them.
    In this phase the API is on the laptop, so a link only opens on that machine.

### 5. Schema and rollback safety

*   One new migration, `0004_clips_and_shares.sql`, creates the two tables with
    `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`. It is additive and
    safe to run twice, since migrations run on every start with no version table. It
    adds no column to `videos`, so rolling back the API image does not break reads.
*   `SELECT *` in `store.go` is replaced with named columns first, so a column added
    to `videos` later cannot break a rolled-back image.
*   `infra/db-setup.sql` is not changed. API start-up owns the schema.

### 6. Local hybrid operation

*   Run the API on the laptop with `DB_IAM_HOST` set to the Aurora endpoint, real AWS
    credentials in the environment, and `LOCAL_DATA_DIR` pointing to a Mountpoint mount
    of the processed bucket. Wake Aurora before the demo, since it pauses after 300
    seconds and resuming takes about 15 seconds.
*   CloudFront, the ALB and the Cognito callback list are not changed.

## Alternatives Considered

### Alternative A: Postgres full-text search with a worker write path and backfill

*   **Pros**: Ranked results. Searches run in the database, not by reading files.
*   **Cons**: The worker has no Aurora access today, so it needs new IAM, a database
    grant and a Data API write. The final pipeline step is retried and could insert
    duplicate rows, and a database error there could mark a good video as failed.
    Existing videos need a backfill. Full-text search matches whole words only, so
    typing "recur" would stop matching "recursion", and the English configuration
    handles non-English transcripts poorly. It does not address the stated problem,
    which is wording and scope, not speed or missed matches.
*   **Reason for Rejection**: Rejected by author: scanning `transcript.json` is fast
    enough for 10 to 30 videos. Add it only if the scan becomes slow.

### Alternative B: Run Ask automatically when the text ends in "?"

*   **Pros**: Fewer clicks for people who already type questions.
*   **Cons**: A hidden mode switch that spends model credits while the user is still
    editing. People who ask without a question mark never learn Ask exists.
*   **Reason for Rejection**: Rejected by author: Ask runs only on Enter or the Ask
    button.

### Alternative C: Library-wide Ask by summaries first, then full transcripts

*   **Pros**: Finds a topic when the question and the speaker use different words.
*   **Cons**: Two model calls, so slower and costlier. The second call can send a
    whole transcript per chosen video. A detail missing from the summary is lost
    because the first call skips the video, and a video with no summary yet cannot be
    chosen.
*   **Reason for Rejection**: Rejected by author: keyword lines plus summaries in one
    call was chosen.

### Alternative D: Ask only on a video page

*   **Pros**: Removes the prompt-size problem for 30 videos.
*   **Cons**: Gives up Ask across the library, which the author asked for.
*   **Reason for Rejection**: Rejected by author: library-wide Ask stays in scope.

### Alternative E: Clips as MP4 files cut by the worker

Two forms were weighed: a playlist that plays at once with an MP4 made only on
Download, and an MP4 cut straight away.

*   **Pros**: A real file that can be downloaded, sent and played outside the site.
    Exact start and end times.
*   **Cons**: Needs worker read access to `processed/*`, a trigger path from the API
    without the AWS SDK (a marker file plus EventBridge, or a signed async invoke), and
    failure handling so a clip cannot stay pending forever (and block deleting the
    video). The HLS chunks have timestamp breaks at each join, so the segments must be
    joined with ffmpeg's concat demuxer and re-encoded. Each clip costs a Lambda run.
*   **Reason for Rejection**: Rejected by author: a clip is a stored time range played
    on the existing stream, with no new file and no worker job. The demo shows a
    range, not a file.

### Alternative F: Cut clips from the original upload

*   **Pros**: Simplest source for ffmpeg.
*   **Cons**: The original upload is deleted after 3 days.
*   **Reason for Rejection**: Rejected by author: not usable because of the 3 day
    expiry. This is moot now that clips are time ranges.

### Alternative G: Share links that point at one clip

Two forms were weighed: limit the viewer to the range in the player only, or sign
URLs only for the segments that cover the range.

*   **Pros**: Lets the owner share a single moment.
*   **Cons**: Limiting the range in the player does not stop a viewer from fetching the
    whole video. Signing only the covering segments needs a trimmed playlist built per
    link.
*   **Reason for Rejection**: Rejected by author: a share link always shows the whole
    video, and a clip is a start-time bookmark.

### Alternative H: Reuse the existing folder URL for share viewers

*   **Pros**: No new route or signing scope.
*   **Cons**: It covers the whole processed folder, including
    `bedrock-request.json` and `progress.json`. It lasts one hour, so a cancelled link
    would keep working for up to an hour. The results route can list directories. It
    stops long videos from playing after an hour.
*   **Reason for Rejection**: Rejected by author: share links get their own signed
    URLs and a `share_links` row.

### Alternative I: Store share tokens somewhere other than Aurora

Two forms were weighed: one S3 object per share, or a stateless signed token plus a
version number on the video.

*   **Pros**: The S3 object form lets a signed-out viewer open a link without waking
    Aurora, which pauses after 300 seconds and takes about 15 seconds to resume. The
    stateless form needs no table.
*   **Cons**: The S3 form revokes by deleting an object and cannot list links per
    video without extra work. The stateless form can only revoke all links of a video
    at once and needs a new column on `videos`.
*   **Reason for Rejection**: Rejected by author: a stored token in the database is
    acceptable, and the owner needs to cancel one link at a time.

### Alternative J: Share media URL refresh by failure, or one long URL

*   **Pros**: Refresh on failure needs no timer and costs nothing in a paused tab. One
    long URL needs no refresh code.
*   **Cons**: Refresh on failure stalls the video at every expiry and needs logic to
    tell "expired" from "cancelled". One long URL (up to 3 hours) lets a cancelled
    link keep playing for that long.
*   **Reason for Rejection**: Rejected by author: the page refreshes on a 4 minute
    timer.

### Alternative K: Add columns to `videos` before fixing `SELECT *`

*   **Pros**: Fewer tables.
*   **Cons**: `store.go` selects `*` into a fixed struct, so any extra column breaks
    reads if the API image is rolled back. Migrations never run down.
*   **Reason for Rejection**: Rejected by author: named columns replace `SELECT *`, and
    this batch adds tables, not columns on `videos`.

### Alternative L: Add the new tables to `infra/db-setup.sql`

*   **Pros**: One place for all schema.
*   **Cons**: The API's start-up migrations already own the schema, and
    `db-setup.sql` does not include migration 0003.
*   **Reason for Rejection**: Not chosen: API start-up already owns the schema, and a
    second source of schema would drift. The author has not ruled on this one.

### Alternative M: Stream Ask answers (Bedrock ConverseStream)

*   **Pros**: Text appears as it is written.
*   **Cons**: The stream uses a binary event format, which must be parsed by hand
    without the SDK.
*   **Reason for Rejection**: Not chosen: hand-parsing the binary stream is extra work
    for no need in the demo. The author has not ruled on this one.

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Security and privacy**:
    *   A share token is 32 random bytes. Only its SHA-256 is stored, so a database
        read does not give working links. The token travels in a header, never in the
        API path or query, so the request log does not hold it.
    *   Every share-view failure returns the same 404. Media signatures use the
        `SHARE` scope, a 5 minute lifetime and a fixed file allowlist.
    *   Ask sends transcript text and summaries to Bedrock. The answer card says so
        once in the Ask button's help text.
    *   Sources shown with an answer come only from line ids the server sent.
*   **Cost and limits**: 30 Asks per user per hour, in memory. 10 active share links
    per video. Clips are capped at 5 minutes. Nothing new is billed by the hour. A
    Nova Lite call is a fraction of a cent by the brief's unchecked estimate.
*   **Performance**: type-ahead pauses 300 ms before a request. With no cache, a
    library search reads up to 30 transcripts. If it is slow on the laptop, add the
    cache listed under Future Improvements.
*   **Rollout and rollback**: the migration is additive and safe to run twice. Rolling
    back the API image leaves the two new tables unused. The AWS changes in
    `infra/` are written now but applied only when the ECS stack is brought up, base
    stack first, then the app stack.

--------------------------------------------------------------------------------

### Additional Resources

*   `concepts_brief.md` in the project root: the brainstorm brief and reviewer notes.
*   `README.md` and `docs/walkthrough.md`: current architecture description.

### Future Improvements

*   **Owner playback URL**: the folder URL the owner's pages use lasts 1 hour, so a
    video longer than that stops playing. The owner results route also lists
    directories. Neither is fixed here. The refresh approach used for share pages
    would fix the first.
*   **Transcript cache or Postgres full-text search**: add if type-ahead or Ask is
    slow.
*   **CloudFront**: turn on when AWS approves the account check, then update the
    Cognito callback list and re-test share links from another machine.
*   **Exports, action items and decisions, collections, speaker labels**: the next
    batch. The transcript stays in S3, so these need no change to this design.
*   **MP4 clips**: if a downloadable file is wanted later, cut it from HLS segments in
    the worker. See Alternative E.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

Build order, each stage shippable on its own:

0.  **Prep**: move the SigV4 helpers, name the columns in `store.go`, check the
    Bedrock route.
1.  **Scope**: the wording is shipped; this stage adds the scope chip, the
    `searched` and `skipped` fields, the 300 ms type-ahead,
    "Keep typing..." and the 10-minute user cache in the middleware.
2.  **Ask**.
3.  **Clips**.
4.  **Share links**.

### Schema (migration `0004_clips_and_shares.sql`)

```text
clips        id uuid pk default gen_random_uuid()
             video_id uuid not null references videos(id) on delete cascade
             start_ms bigint not null, end_ms bigint not null
             title text not null default ''
             created_at timestamptz not null default now()
             check (start_ms >= 0 and end_ms > start_ms and end_ms - start_ms <= 300000)
             index on (video_id)

share_links  id uuid pk default gen_random_uuid()
             video_id uuid not null references videos(id) on delete cascade
             token_hash text not null unique
             created_at timestamptz not null default now()
             expires_at timestamptz not null
             revoked_at timestamptz null
             index on (video_id)
```

### API contract

```text
GET    /api/search?q=&video_id=      -> {results, searched, skipped}
POST   /api/ask {q, video_id?}       -> {answer?, sources[{video_id,title,from_ms,text}], matches[...], note?}
POST   /api/videos/:id/clips         {start_ms,end_ms,title?} -> clip
GET    /api/videos/:id/clips         -> {clips}
DELETE /api/videos/:id/clips/:cid    -> 204
POST   /api/videos/:id/shares        {days: 1|7|30} -> {id, token, expires_at}   (token shown once)
GET    /api/videos/:id/shares        -> {shares[{id,created_at,expires_at,state}]}
DELETE /api/videos/:id/shares/:sid   -> 204
GET    /api/share-view               header X-Share-Token -> {title, base, base_expires_at, clips} | 404
GET    /api/share-files/:exp/:sig/*key  (allowlist, SHARE scope, ranges) 
```

### Target Files to Create/Modify

#### Backend

1.  `backend/internal/db/migrations/0004_clips_and_shares.sql` (Create)
    *   **Type / Scope**: SQL migration.
    *   **Proposed Changes**: the two tables above, using `CREATE TABLE IF NOT EXISTS`
        and `CREATE INDEX IF NOT EXISTS` only. No column on `videos`. No data
        movement. No grant to the `pipeline` role, which does not need these tables.

2.  `backend/internal/awsapi/sigv4.go` (Create)
    *   **Type / Scope**: Go package, standard library only.
    *   **Proposed Changes**: `Creds` and `LoadCreds` (moved from
        `internal/db/iamauth.go`: container credentials, then environment variables),
        `Sha256Hex`, `HMACSHA256`, and `SignRequest(req, service, region, body, creds,
        now)`, which sets `Host`, `X-Amz-Date`, `X-Amz-Security-Token`,
        `X-Amz-Content-Sha256` and `Authorization`. The canonical path encodes each
        path segment twice, so `:` in a model id becomes `%253A`.
    *   **Wire path**: Go's `url.URL` sends `:` unescaped by default, which would not
        match the signature. The Bedrock client builds the path itself: each segment
        is escaped once with `url.PathEscape` plus `:` → `%3A`, and the request sets
        both `URL.Path` (unescaped) and `URL.RawPath` (escaped once), so the request
        line carries `/model/apac.amazon.nova-lite-v1%3A0/converse`. The signer
        builds the canonical path from `URL.EscapedPath()` and escapes it once more.
        The test asserts both strings: the wire path with `%3A` and the canonical
        path with `%253A`.

3.  `backend/internal/awsapi/bedrock.go` (Create)
    *   **Type / Scope**: Go client.
    *   **Proposed Changes**: `Converse(ctx, modelID, system, user string, maxTokens int)`
        posts to `https://bedrock-runtime.<region>.amazonaws.com/model/<id>/converse`
        with a 45 second client timeout, returns the text and the `usage` token
        counts. Any non-200 is returned as an error; callers fall back on any error.

4.  `backend/internal/awsapi/sigv4_test.go` (Create)
    *   **Type / Scope**: Go unit test.
    *   **Proposed Changes**: checks the signature of a published AWS SigV4 test-suite
        request with fixed credentials and time; checks that a path containing
        `apac.amazon.nova-lite-v1:0` is double-encoded in the canonical request.

5.  `backend/internal/db/iamauth.go` (Modify)
    *   **Type / Scope**: Go.
    *   **Proposed Changes**: remove `awsCreds`, `loadCreds`, `sha256Hex` and
        `hmacSHA256`; call the `awsapi` versions. `presign` keeps its behavior.

6.  `backend/internal/db/iamauth_test.go` (Modify)
    *   **Type / Scope**: Go unit test.
    *   **Proposed Changes**: use the moved helpers. The existing expected presigned
        URL must not change.

7.  `backend/internal/config/config.go` (Modify)
    *   **Type / Scope**: Go.
    *   **Proposed Changes**: add `BedrockModelID` from `BEDROCK_MODEL_ID`, default
        `apac.amazon.nova-lite-v1:0`.

8.  `backend/internal/models/models.go` (Modify)
    *   **Type / Scope**: Go.
    *   **Proposed Changes**: add `Clip` and `ShareLink` structs with `db` and `json`
        tags. `ShareLink` has no token field. `Video` is unchanged.

9.  `backend/internal/store/store.go` (Modify)
    *   **Type / Scope**: Go.
    *   **Proposed Changes**: replace `SELECT *` in `ListVideosForUser` and `GetVideo`
        with one named column list constant. Add `CreateClip`, `ListClips`,
        `DeleteClip`, `CreateShare`, `ListShares`, `RevokeShare`,
        `CountActiveShares` and `ShareByHash`, where `ShareByHash` returns the video
        only if the row is not revoked, not expired and the video is `ready`.
    *   **Ownership (security)**: `DeleteClip(videoID, clipID)` and
        `RevokeShare(videoID, shareID)` take both ids and run `... WHERE id = $1 AND
        video_id = $2`, returning not found when no row matched. The handler first
        loads the video by `:id` and checks it belongs to the caller (the existing
        `GetVideo` + `UserID` check), then passes `:id` and the clip or share id. A
        clip or share id from another user's video therefore matches no row. Do not
        copy the `DeleteVideo(id)` pattern, which takes one id. A handler test
        covers user B deleting user A's clip and cancelling user A's link: both get
        404 and the rows stay.

10. `backend/internal/storage/local.go` (Modify)
    *   **Type / Scope**: Go.
    *   **Proposed Changes**: add `shareURLTTL = 5 * time.Minute`, `ShareDirURL(prefix)`
        returning `/api/share-files/<exp>/<sig>/<prefix>`, signed with the `SHARE`
        scope. `Verify` already takes the scope string, so no new verifier is needed.

11. `backend/internal/storage/local_test.go` (Modify)
    *   **Type / Scope**: Go unit test.
    *   **Proposed Changes**: a `SHARE` signature does not verify as `DIR` or `GET`
        and the reverse; a signature past its expiry fails.

12. `backend/internal/handlers/transcripts.go` (Create)
    *   **Type / Scope**: Go.
    *   **Proposed Changes**: `loadTranscript(storage, prefix)` returns the segments of
        `transcript.json` or an error. No cache. Used by search and Ask.

13. `backend/internal/handlers/videos.go` (Modify)
    *   **Type / Scope**: Go handler.
    *   **Proposed Changes**: `Search` uses `loadTranscript`, returns `searched`
        (count) and `skipped` (titles). Logs each transcript it cannot read.
        Matching rule unchanged. `Delete` needs no change because the new tables
        cascade.

14. `backend/internal/handlers/ask.go` (Create)
    *   **Type / Scope**: Go handler.
    *   **Proposed Changes**: `Ask` builds the context per scope as described in the
        Technical Plan: stop-word list, minimum word length 3, scoring by distinct
        words, top 30 lines with neighbours, 12,000 character cap, summaries of at
        most 5 videos. Sends lines with ids, parses `{answer, sources}`, strips code
        fences, drops unknown ids, falls back to matches on any model error. Holds the
        30 per hour per user counter (returns 429 with a message). Logs one line per
        call.

15. `backend/internal/handlers/ask_test.go` (Create)
    *   **Type / Scope**: Go unit test.
    *   **Proposed Changes**: word selection and scoring; the 12,000 character cap;
        unknown source ids are dropped; no valid source gives the "couldn't find"
        result; zero matching lines makes no model call (fake client); a model error
        returns matches with a note; the 31st Ask in an hour gets 429.

16. `backend/internal/handlers/clips.go` (Create)
    *   **Type / Scope**: Go handler.
    *   **Proposed Changes**: create, list and delete, owner only, ready videos only.
        `videoDurationMS` sums `#EXTINF` of the first rendition playlist under
        `hls/`. Rejects `end_ms` past the duration and ranges over 300,000 ms.

17. `backend/internal/handlers/clips_test.go` (Create)
    *   **Type / Scope**: Go unit test.
    *   **Proposed Changes**: duration from a sample playlist; range validation cases
        (negative start, start after end, over 5 minutes, past the end).

18. `backend/internal/handlers/shares.go` (Create)
    *   **Type / Scope**: Go handler.
    *   **Proposed Changes**: owner routes (create, list, revoke), `ShareView`, and
        `ShareFile`. `ShareFile` verifies the `SHARE` signature for the video prefix,
        matches the key against the allowlist, requires a regular file and serves it
        with range support. `ShareView` sets `Referrer-Policy: no-referrer` and
        `Cache-Control: no-store`.

19. `backend/internal/handlers/shares_test.go` (Create)
    *   **Type / Scope**: Go unit test.
    *   **Proposed Changes**: allowlist accepts the listed files and refuses
        `labels.json`, `bedrock-request.json`, `progress.json`, directories and `..`
        paths; a signature for another video's prefix is refused; an owner `DIR`
        signature is refused; token generation is 43 URL-safe characters and the
        stored value is its SHA-256.

20. `backend/internal/handlers/middleware.go` (Modify)
    *   **Type / Scope**: Go middleware.
    *   **Proposed Changes**: remember the user id for each Cognito `sub` for 10 minutes
        so `UpsertCognitoUser` is not called per request. Add `X-Share-Token` to
        `Access-Control-Allow-Headers`.

21. `backend/internal/router/router.go` (Modify)
    *   **Type / Scope**: Go routes.
    *   **Proposed Changes**: add the routes in the API contract. `/api/share-view` and
        `/api/share-files/...` sit outside the auth group. `/api/ask` and the clip and
        share owner routes sit inside it.

22. `backend/cmd/server/main.go` (Modify)
    *   **Type / Scope**: Go entry point.
    *   **Proposed Changes**: build the Bedrock client from the configured region and
        model, and pass the new handlers to the router.

#### Front end

23. `frontend/src/api/client.ts` (Modify)
    *   **Type / Scope**: TypeScript API client.
    *   **Proposed Changes**: `search(q, videoId?)` returning `searched` and `skipped`;
        `ask`, clip functions, share functions; `shareView(token)` using plain `fetch`
        with the `X-Share-Token` header and a `null` result for any 404.

24. `frontend/src/components/Shell.tsx` (Modify)
    *   **Type / Scope**: React component.
    *   **Proposed Changes**: keep the shipped icon, placeholder, aria label and
        tooltip; when the chip is "This video", the aria label and tooltip say "this
        video" instead of "all your videos". Add a scope chip that defaults to "This video" on `/videos/:id` and
        "All videos" elsewhere, and can be switched; an Ask button labelled with the
        scope. Typing updates the `q` parameter after 300 ms (on `/search` or on the
        video page, using replace so the back button is not flooded). Enter and the
        Ask button set `ask=1`.

25. `frontend/src/components/AskCard.tsx` (Create)
    *   **Type / Scope**: React component.
    *   **Proposed Changes**: shows the loading state, the answer, the scope label and
        sources as clickable timestamps (link to `/videos/:id?t=<seconds>`; on the same
        video it seeks and scrolls the player into view, skipping smooth scroll when
        reduced motion is set), and the notes for failure, rate limit and no source.

26. `frontend/src/pages/Search.tsx` (Modify)
    *   **Type / Scope**: React page.
    *   **Proposed Changes**: keep the shipped header (the query in quotes) and
        results line, and add "N videos searched" from `searched`. The Search page is
        always library-wide. Add a line naming videos still
        processing (from `skipped`), "Keep typing..." under 2 characters, and the
        AskCard above the results when asked. Keep the shipped empty-state text and
        append "Press Enter to ask."

27. `frontend/src/pages/VideoDetail.tsx` (Modify)
    *   **Type / Scope**: React page.
    *   **Proposed Changes**: filter the loaded transcript by the `q` parameter; show the
        AskCard above it when `ask=1`; mount the clips and share panels; export `Watch`,
        `ChapterStrip`, `Transcript` and `Card` for the share page (the Tags and labels
        cards and `Chips` are already removed). Updated delete confirmation text.
    *   **`Watch` for the share page**: `Watch` becomes a pure player. It takes
        `base` (the current signed folder URL), `poster`, `captions` (VTT URL),
        `startAt`, an optional clip to stop at, and an optional `rewrite(url)`
        hook for hls.js requests. It does not import `api/client` and calls no
        signed-in endpoint. Progress polling (`getProgress`), the processing tracker
        and `Skeleton` stay in `VideoDetail`, which only renders `Watch` once the
        video is ready, so the share page never touches them.

28. `frontend/src/components/ClipsPanel.tsx` (Create)
    *   **Type / Scope**: React component.
    *   **Proposed Changes**: set start and end from the current time or a chapter; save;
        list with play and delete; shows the server's error text for refused ranges.

29. `frontend/src/components/SharePanel.tsx` (Create)
    *   **Type / Scope**: React component.
    *   **Proposed Changes**: choose 1, 7 or 30 days, create, show the link once with a
        copy button, list links with state and a Cancel button.

30. `frontend/src/pages/SharePage.tsx` (Create)
    *   **Type / Scope**: React page.
    *   **Proposed Changes**: reads the token from the route, calls `shareView`, renders
        the player, chapters, summary, transcript and clip bookmarks in its own frame,
        refreshes every 4 minutes, shows one "link not available" page on any failure.
        Uses hls.js with a request hook that rewrites the signed part of each URL; for
        native HLS it sets the source again and seeks to the saved position.
    *   **Every media URL follows the refresh**, not only segments. The page keeps
        the newest base in state and builds all URLs from it: poster
        (`thumbs/thumb_01.jpg`), captions (`transcript.vtt`), chapter thumbnails and
        clip thumbnails. A new base re-renders those `src` values. The captions
        track is fetched once by the browser when playback starts, so a later
        expiry does not drop captions; the poster only matters before playback.
        Chapter and clip thumbnails reload with the new base, so none of them show
        broken images after 5 minutes. `summary.json` and `transcript.json` are
        read once on load and kept in memory.

31. `frontend/src/App.tsx` (Modify)
    *   **Type / Scope**: routes.
    *   **Proposed Changes**: add `/share/:token` outside `ProtectedRoute`.

#### Infrastructure (written now, applied when the ECS stack is up)

32. `infra/outputs.tf` (Modify)
    *   **Type / Scope**: Terraform base stack.
    *   **Proposed Changes**: export the Bedrock profile ARN and model ARN already
        built in `infra/stepfunctions.tf`, so there is one value.

33. `infra/app/app.tf` (Modify)
    *   **Type / Scope**: Terraform app stack.
    *   **Proposed Changes**: add an IAM policy on `api_task` allowing
        `bedrock:InvokeModel` on those two ARNs; set `BEDROCK_MODEL_ID` in the API
        container. No NAT Gateway, no VPC endpoint.

#### Documentation

34. `README.md` (Modify)
    *   **Type / Scope**: documentation.
    *   **Proposed Changes**: replace "Our code makes no AWS API calls" (the API now
        signs Bedrock calls); describe the search box scopes, Ask, clips and share
        links; point local hybrid mode at `backend/run-hybrid.sh` and
        `frontend/.env.local`; remove the remaining Rekognition and labels text
        (pipeline diagram, "Seen in the video", `labels.json`).

35. `docs/walkthrough.md` (Modify)
    *   **Type / Scope**: documentation.
    *   **Proposed Changes**: add the new routes, the two tables, and the share flow.
        Remove the Rekognition branch and labels text from the pipeline sections.

### Review decisions (round 1)

*   **Built in stage 1, replacing the chip.** There is no scope chip. The page sets
    the scope: on a video page the box says "Search this video" and filters that
    transcript; everywhere else it searches all videos. With no match on a video
    page, a "Search all videos instead" link opens `/search?q=`. Clearing the box
    on `/search` returns to the library. Ask (stage 2) follows the same rule: on a
    video page it asks about that video, elsewhere about all videos.

These settle the implementation readiness report. Where an item above disagrees
with this section, this section wins.

*   **B2, hls.js hook.** Use a custom loader: `class ShareLoader extends
    Hls.DefaultConfig.loader`, overriding `load(context, ...)` to set
    `context.url = context.url.replace(/\/api\/share-files\/\d+\/[^/]+\//,
    currentBase())`, then calling `super.load`. Pass it as `loader` (not
    `xhrSetup`). `currentBase()` reads the newest base from a ref. The video page
    passes no loader. Item 27's "a function that supplies the current signed base"
    is this `currentBase`; item 30's "rewrites the signed part" is this regex.
*   **B3, signer signature.** `func SignRequest(req *http.Request, service,
    region string, body []byte, c Creds, now time.Time) error`. It reads the path
    from `req.URL.EscapedPath()`.
*   **M2, reuse.** Factor the prefix-and-verify part of `FilesHandler.Result`
    into `func (h *FilesHandler) serveSigned(c *gin.Context, scope string, allow
    func(key string) bool)`. `Result` calls it with `DIR` and an allow-all
    function; `ShareFile` calls it with `SHARE` and the allowlist plus a
    regular-file check. `shares_test` copies `TestResultScopedToVideoFolder`.
*   **M3, store.** Column list: `const videoColumns = "id, user_id, title,
    original_key, content_type, status, results, created_at, updated_at"`.
    Signatures:
    *   `CreateClip(videoID, title string, startMS, endMS int64) (models.Clip, error)`
    *   `ListClips(videoID string) ([]models.Clip, error)`, ordered by `start_ms`
    *   `DeleteClip(videoID, clipID string) (bool, error)`
    *   `CreateShare(videoID, tokenHash string, expiresAt time.Time) (models.ShareLink, error)`
    *   `ListShares(videoID string) ([]models.ShareLink, error)`, newest first
    *   `RevokeShare(videoID, shareID string) (bool, error)`
    *   `ShareByHash(tokenHash string) (models.Video, error)`, `sql.ErrNoRows` on
        any miss

    "Active" means `revoked_at IS NULL AND expires_at > now()`. `token_hash` is
    the lowercase hex SHA-256 of the token. The 10-link cap is one statement, so
    two requests cannot pass it together: `INSERT ... SELECT $1, $2, $3 WHERE
    (SELECT count(*) FROM share_links WHERE video_id = $1 AND <active>) < 10
    RETURNING ...`; no row means the cap was hit (`ErrTooManyShares`).
    `CountActiveShares` is dropped. `DeleteClip` and `RevokeShare` use `WHERE id
    = $1 AND video_id = $2` (see item 9).
*   **M4, Ask request.** `q` is 2 to 300 characters. Converse body:
    `{"system":[{"text":SYSTEM}],"messages":[{"role":"user","content":[{"text":USER}]}],"inferenceConfig":{"maxTokens":800,"temperature":0.2}}`.
    Answer text is `output.message.content[0].text`; tokens are
    `usage.inputTokens` and `usage.outputTokens`. SYSTEM: "Answer only from the
    numbered transcript lines. Reply with JSON only: {\"answer\": string,
    \"sources\": [line numbers]}. If the lines do not answer the question, reply
    {\"answer\": \"\", \"sources\": []}." Strip fences with
    `` ^```(?:json)?\s*|\s*```$ `` before parsing.
    *   **Library scope:** take lines that contain any non-stop word of `q` (stop
        words: a, an, and, are, did, do, does, for, how, i, in, is, it, of, on, or,
        that, the, this, to, was, we, what, when, where, who, why, you), plus one
        neighbour each side, dedupe by video and `from_ms`, keep transcript order,
        and cap at 30 lines and 12,000 characters, neighbours included. With no
        matching line, use the summaries of the 5 most recently created ready
        videos.
    *   **Video scope (`video_id` set):** send the whole transcript, cut at
        `worker.MaxTranscriptChars` (exported from `maxTranscriptChars`).
    *   The response has `truncated: true` when either cap cut the context.
*   **M5, wiring.** `awsapi` exposes `type Converser interface {
    Converse(ctx context.Context, system, user string) (Reply, error) }`; tests
    use a fake. New handlers: `AskHandler{Store, Storage, AI Converser}`,
    `ClipHandler{Store}`, `ShareHandler{Store, Storage}`. `Deps` gains `Ask`,
    `Clips`, `Shares`; `main.go` builds them. Router: `/api/ask` gets its own group
    with `Use(d.Auth)`; clip and share owner routes go in the existing `videos`
    group; `/api/share-view` and `/api/share-files/*` go in a group with no auth.
*   **M6, errors and shapes.** All errors are `{"error": "<message>"}`:
    400 for bad input (clip range invalid or over 5 minutes, `days` not 1, 7 or 30,
    `q` length); 404 for a missing video or one that is not the caller's; 409 for a
    video that is not ready, and for the 11th active link. `days` is optional,
    default 7. `matches` items have the same shape as a search hit. `POST` clips
    returns 201 and the clip. Share `state` is `active`, `expired` or `revoked`.
    `base` is a path relative to the API, like `results_url`; the client prefixes
    `API_BASE_URL`. `base_expires_at` is Unix seconds. `ShareDirURL` returns
    `(url string, exp int64)`. The share link is built in the browser as
    `${location.origin}/share/${token}`.
*   **M7, seeking.** `Watch` uses `forwardRef` and exposes `{ seek(seconds) }`, and
    takes `onTime(seconds)`, called on `timeupdate`. `VideoDetail` holds the ref
    and the current time and passes `seek` to AskCard, ClipsPanel and the
    transcript. A changed `?t=` on the open page calls `seek` from an effect, not
    through the one-time `started` guard. Clip playback: `Watch` takes `stopAt`;
    on `timeupdate`, if the time reaches it, it pauses and clears `stopAt`.
*   **M8, navigation.** On any page except a video page, typing goes to
    `/search?q=` (push on the first change, replace after that). On a video page
    with "This video", typing replaces `?q=` on that page and filters locally.
    Switching the chip to "All videos" on a video page pushes `/search?q=`. Enter
    or the Ask button adds `ask=1`, and on a video page also scopes Ask to that
    video.
*   **M9, stages.** Each item belongs to the stage of the feature it serves; a
    file used by several stages is edited in each. All stages use the same
    checks: `go build ./... && go test ./... && go vet ./...` and `npm run build
    && npm run lint`. No per-stage commands.
*   **M10, gate.** It runs before stage 2, in this order. Each check must pass.
    1.  `aws freetier get-account-plan-state --region us-east-1` shows the Free
        plan with credits left (the rule for adding a service).
    2.  `aws bedrock list-inference-profiles --region ap-south-1` lists
        `apac.amazon.nova-lite-v1:0`.
    3.  With the API in hybrid mode, one `POST /api/ask` returns 200 with an answer.

    The ECS check waits until the app stack is next up; if it fails then, stop and
    re-plan. Terraform names: outputs `bedrock_profile_id`, `bedrock_profile_arn`,
    `bedrock_model_arn` (the model ARN moves into a local in
    `infra/stepfunctions.tf`); policy `aws_iam_role_policy.api_task_bedrock`; env
    `BEDROCK_MODEL_ID = local.base.bedrock_profile_id`.
*   **Nits.**
    *   N1: add tests for the `searched`/`skipped` counts, sub cache hit and
        expiry, `loadTranscript` on bad JSON, `ShareView` with revoked, expired,
        not-ready and malformed tokens, the 10-link cap, delete cascading to clips
        and links, and the clip/share ownership cases in item 9. Named pure
        functions with tests: `SignRequest`, `escapePath`, `pickContext`,
        `parseAnswer`, `allowShareKey`, `validClip`.
    *   N2: wake Aurora as the first E2E step.
    *   N3: "first rendition" means the first `#EXT-X-STREAM-INF` entry in
        `master.m3u8`.
    *   N4: `loadTranscript(prefix string) ([]worker.Segment, error)`, with the
        worker's `segment` type exported as `Segment`.
    *   N5: the sub cache is a `map` behind a `sync.Mutex`; entries older than 10
        minutes are treated as missing and overwritten. No background sweep.
    *   N6: the UI says "cancel", the code and API say "revoke".
    *   N7: clip titles are 1 to 100 characters; clips are listed by start time.
    *   N8: the prep stage checks Bedrock network reachability and IAM permission.
    *   N9: delete confirmation: "Delete "<title>"? This removes the video, its
        clips, its share links and its results for good."
    *   N10: "so there is one value" means the API and pipeline read the same ARN;
        the keyboard check covers search, Ask, clip save and share create.

### Verification Plan

*   **Gate check before Ask (run by the author)**: `aws freetier
    get-account-plan-state --region us-east-1`; a read-only Bedrock call such as
    `aws bedrock list-inference-profiles` in the target region; one test Converse
    call from the laptop through the new signer. For the ECS path, confirm the task
    role policy and that the task reaches `bedrock-runtime` with no NAT or endpoint,
    when the stack is next up. Pass rules and order are in "Review decisions", M10.
*   **Compilation/Build**: `cd backend && go build ./...`; `cd frontend && npm run build`.
*   **Unit Tests**: `cd backend && go test ./...`, which includes the new signer,
    storage, Ask, clips and share tests.
*   **Static Analysis & Linting**: `cd backend && go vet ./...`;
    `cd frontend && npm run lint`.
*   **Test Coverage Requirement**: every new pure function above has a test. Handlers
    that need Aurora are checked by the end-to-end run.
*   **E2E/Integration**: run the API in local hybrid mode, then walk the demo script in
    a real browser: upload, wait for processing, type a word, press Enter to Ask and
    click a source, save a clip and play it, create a share link, open it in a second
    signed-out browser profile, check that the page has no search, Ask or delete and
    that `bedrock-request.json` and `progress.json` return 404 through
    `/api/share-files` (both files exist, so this proves the allowlist), play past 5 minutes to see the refresh, cancel the
    link and confirm that reloading shows the "link not available" page and playback
    stops within 5 minutes. Check the keyboard path and reduced-motion setting. Wake
    Aurora before the run.

--------------------------------------------------------------------------------

<!-- Provenance: Indicates initial structural drafting via EGM. -->

*Drafted with EGM*
