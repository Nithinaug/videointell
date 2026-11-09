# Implementation Readiness Report: ask-clips-share-links.md

- Target: `docs/designs/ask-clips-share-links.md`, DetailedRange lines 499-806 ("Detailed Implementation Plan" to end of file)
- Stage: 9 (Implementation Readiness Test), round 1
- Reviewers: egm-implementation-readiness (completed), egm-codebase-details (completed), egm-style (completed)
- Standard: `implementation-readiness-standard.md` (readiness and codebase reviewers)
- Facts given by the author: Section 1 search wording (icon, placeholder, results line) is built; Rekognition labels are removed from the pipeline.

**Verdict: not ready.** After merging duplicates, there are 4 Blockers, 10 Majors and 10 Nits. All three reviewers independently flagged the two problems behind your facts: the plan rebuilds Section 1, and it still uses labels.

---

## 🔴 Blockers

### B1. The plan rebuilds the Section 1 wording, with different text
Lines: 505 (stage 1 "Wording and scope"), 616-626 (items 12, 13), 697-704 (item 24), 713-718 (item 26). Raised by all three reviewers.

- Item 24 sets the placeholder to "Search what was said in your videos". The shipped one is "Find a moment: type words someone said" (`frontend/src/components/Shell.tsx:50`).
- Item 26 sets the header "Spoken words in N videos matching...". The shipped one is "Moments where this was said, across all your videos" (`frontend/src/pages/Search.tsx:56`).
- Item 12 says to "(Create)" `transcripts.go`. Check whether it exists before marking it.
- **Still to build from Section 1:**
  - the scope chip
  - the 300 ms type-ahead
  - `video_id`, `searched` and `skipped` on Search (`backend/internal/handlers/videos.go:106-154` has none of them)
  - "Keep typing..."
  - the processing-videos line
  - the middleware user cache
- Fix: mark the wording done and say the shipped text is the final version. Then rename stage 1 and cut items 24 and 26 down to the new parts only (the Ask button, the scope label and the `ask=1` handling).

### B2. Share-page player and signed-URL refresh are not designed
Lines: 720-726 (item 27), 738-744 (item 30). Raised by readiness and codebase.

- `Watch` (`VideoDetail.tsx:218`) takes `detail: VideoDetailT`. The share API returns `{title, base, base_expires_at, clips}`. The plan never says how SharePage builds `detail` and `results`, or whether it reuses `getResults` (`client.ts:129`).
- While `results` is null, `Watch` renders `Skeleton` and `Tracker`. `Tracker` calls the authenticated `getProgress`, so a signed-out viewer gets a 401, and the axios interceptor sends them to Cognito (`client.ts:17-23`). Lines 288-289 forbid exactly that.
- The poster, the captions `<track>` and the chapter thumbnails also use the 5-minute signed base. The plan only refreshes segment requests, so these break after 5 minutes.
- The hls.js hook is not named (`xhrSetup`, `fetchSetup` or a custom loader), and the rewrite regex is not given. Item 27 ("a function that supplies the current signed base") and item 30 ("rewrites the signed part of each URL") describe two different designs.
- Fix:
  - give the new `Watch` props exactly, for example `base`, `title`, `stopAt` and `getBase()` instead of `detail`
  - never render `Tracker` or `Skeleton` on a share page
  - name the hook and the regex
  - say whether the poster, track and thumbnails are re-pointed on each refresh

### B3. SigV4 wire path and signer signature are not specified
Lines: 559-562, 566-569, 574-575. Raised by readiness.

- The plan gives the canonical path (`:` becomes `%253A`) but not the wire path. On the wire it must be `/model/apac.amazon.nova-lite-v1%3A0/converse`. Go's `url.Parse` leaves `:` unescaped, so without `req.URL.RawPath` or `Opaque` the signature does not match and every Ask call fails.
- `SignRequest(req, service, region, body, creds, now)` has no parameter types and no return value.
- Fix: state the wire encoding and the Go signature, and add a test that checks the wire path.

### B4. False "already has uncommitted changes" notes
Lines: 761-762 (`infra/app/app.tf`), 770-771 (`README.md`), 775-776 (`docs/walkthrough.md`). Raised by all three reviewers (rated Blocker, Major or Nit).

The git status is clean, so these notes tell the implementer to review changes that do not exist. Working-tree state goes out of date as soon as you commit. Fix: delete the three sentences.

---

## 🟡 Majors

### M1. Labels and Rekognition leftovers
Lines: 667 (item 19), 723-724 (item 27), 766-776 (items 34-35), 797 (E2E). Raised by all three reviewers.

- Item 27 exports `Chips`, but no `Chips` component exists.
- The E2E check "`labels.json` returns 404" now passes because the file is missing, not because the allowlist refused it, so it proves nothing. Test `bedrock-request.json` and `progress.json` instead, which exist and must be refused. Also test a directory URL.
- The README and walkthrough items do not say to remove the label pipeline text. The reviewers found 17 or more matches in walkthrough.md and about 20 lines in the README.
- Outside the plan's range, the same problem appears at lines 39, 281, 291-292 and 396 ("Tags" and "Seen in the video" cards).

### M2. `ShareFile` copies `FilesHandler.Result` instead of reusing it
Lines: 656-670 (items 18-19). Raised by codebase and readiness.

`videos.go:315-333` already does four things item 18 needs:
- it cleans the path
- it takes the `processed/<user>/<video>/` prefix
- it calls `Storage.Verify(scope, ...)`
- it serves with `c.File`, which supports range requests

Two copies of security-critical path parsing can drift apart. Fix: factor out the prefix-and-verify logic with the scope (`DIR` or `SHARE`) as a parameter. Add only the allowlist and the regular-file check on top, and use `TestResultScopedToVideoFolder` as the template for shares_test.

### M3. Store methods have no signatures, and delete/revoke are not scoped to the video
Lines: 597-603 (item 9), 647, 658. Raised by codebase and readiness.

- The eight methods are listed by name only, with no signatures or SQL.
- `DeleteClip` and `RevokeShare` must match on both ids, for example `WHERE id=$1 AND video_id=$2`. If they copy the bare-id pattern of `DeleteVideo(id)`, a user can delete another user's clip or link by pairing their own video id with that clip or share id. This is an authorization hole.
- "Active" is not defined for `CountActiveShares`.
- The race between `CountActiveShares` and `CreateShare` is not addressed: two requests at once can push past the 10-link cap.
- The `ShareByHash` return type and the `token_hash` encoding are not given.
- The `Video` column list is not written out. It must include `results`: id, user_id, title, original_key, content_type, status, results, created_at, updated_at.

### M4. Ask prompt and Converse request/response not specified
Lines: 566-569, 628-636 (item 14). Raised by readiness and style.

Missing:
- the system prompt and the instruction to return JSON
- the `maxTokens` and temperature values
- the request body and the response path (`output.message.content[0].text`, `usage.*`)
- the stop-word list
- whether neighbour lines count toward the 30-line and 12,000-character caps, and how overlapping neighbours are removed
- how the 5 summary videos are picked
- which field says an answer was cut
- the length limits for `q`

Item 14 says "per scope" but describes only the library-wide scope. The 300,000-character cap is the unexported `maxTranscriptChars` (`worker.go:19`): export it or copy it. "Strip code fences as the summary step does" points to JSONata (`infra/stepfunctions.tf:153`), not Go. Give the regex.

### M5. Bedrock client cannot be faked; handler types and wiring not named
Lines: 564-569, 628-645, 678-687 (items 3, 14-15, 21-22). Raised by readiness and codebase.

- Item 15 needs a fake client, but item 3 defines only a concrete `Converse` function. Define a small interface for it.
- Name the new handler structs, the `Deps` fields and the wiring in `main.go`.
- Item 21 refers to "the auth group", but none exists. `router.go:28-41` applies auth per group. `/api/ask` needs its own group with `Use(d.Auth)`; clips and shares fit under `videos`.
- The typed 429/5xx error is not needed, because line 230 falls back on any error.

### M6. API error contract and some response shapes missing
Lines: 530-543. Raised by readiness and style.

Missing:
- status codes and `{error}` bodies for clip validation errors, a video that is not ready, a video that is not the caller's, the 11th link and a bad `days`
- the shape of `matches[...]`
- the POST clips response
- the share `state` values
- whether `base` is relative
- the format of `base_expires_at`
- where the `/share/<token>` link comes from

Two mismatches with the Technical Plan:
- `days` is shown as required, but line 262 gives it a default of 7.
- `base_expires_at` does not appear in the Technical Plan (line 168).

`ShareDirURL` must return `(url, exp)` to fill `base_expires_at`, but `DirURL` returns only a string (`local.go:46-49`).

### M7. Seeking within the same video and component wiring for clips
Lines: 706-711, 720-731 (items 25, 27-28). Raised by readiness and codebase.

- `seek` and `time` are private to `Watch`.
- `?t=` is applied once, guarded by the `started` ref (`VideoDetail.tsx:265`), so changing `?t=` on the open page does not seek.
- ClipsPanel and AskCard both need the current time and a way to seek. Choose one: lift the state, forward a ref, or pass an `onSeek` callback.
- Tie "pause at end_ms" to a named event.

### M8. Scope-chip navigation is ambiguous
Lines: 697-704, 713-722. Raised by readiness.

- What does typing on `/` do, and is it a push or a replace?
- What does switching the chip to "All videos" do on a video page?
- When does `/search` carry `video_id`? Item 26 says the Search page can show "in this video", but item 27 says the video page filters locally.

### M9. Stages are not split at the file level
Lines: 501-508, 545-776. Raised by readiness.

Line 501 claims each stage ships on its own, but files are not grouped by stage. These files span stages: router.go, main.go, store.go, models.go, middleware.go, client.ts and VideoDetail.tsx. Tag each item with its stage and give each stage its own build and test commands.

### M10. Bedrock gate, its pass rule and fallback, and the Terraform names
Lines: 503-504, 752-761, 780-785 (items 32-33, gate check). Raised by all three reviewers.

- The gate has no command for the laptop test call and no pass/fail rule for each check.
- Its position is unclear: does it run before stage 2? The ECS check runs "when the stack is next up", which may be after Ask is built.
- It does not say why it runs `aws freetier get-account-plan-state`.
- The fallback, "Ask moves to a Lambda", has no design. Either specify it or say "stop and re-plan".
- Terraform: only `local.bedrock_profile_arn` exists. The model ARN is inline in the policy, and `var.bedrock_profile` is not exported. Name:
  - the outputs: `bedrock_profile_id`, `bedrock_profile_arn` and `bedrock_model_arn`, with the model ARN moved into a local
  - the policy resource: `aws_iam_role_policy.api_task_bedrock`
  - the env value: `BEDROCK_MODEL_ID = local.base.bedrock_profile_id`

---

## 🟢 Nits

- **N1** (786-800) Missing tests:
  - Search with `video_id`: 404 for another user's video, and the `searched`/`skipped` counts
  - the sub cache: hit, expiry, concurrent access
  - `loadTranscript` on bad JSON
  - `ShareView` on revoked, expired, not-ready and malformed tokens
  - the 10-link cap
  - delete cascading to clips and links
  - the native-HLS refresh path
  - `X-Share-Token` never appearing in logs

  Line 791 ("every new pure function has a test") cannot be checked. Name the functions.
- **N2** (793-800) Move "Wake Aurora before the run" to the start of the E2E step, and make the step a numbered list.
- **N3** (647-649) "First rendition playlist" is ambiguous. Say "first `#EXT-X-STREAM-INF` entry in master.m3u8". `Assemble` (`worker.go:251-261`) already parses `#EXTINF`.
- **N4** (616-619) Give the return type of `loadTranscript`.
- **N5** (672-676) The sub cache needs a mutex and an eviction rule.
- **N6** (601, 526, 736, 798) One action has three names: revoke, cancel, and "cancel the link". Pick one, or map them once.
- **N7** (728-731) The clip title has no maximum length, and the list order is not stated.
- **N8** (503) "Check the Bedrock route" reads as an HTTP route. Say network reachability and IAM permission.
- **N9** (726) "Updated delete confirmation text." gives no wording. Give the text or point to lines 295-296.
- **N10** (755, 799, 783) Vague phrases:
  - "so there is one value"
  - "check the keyboard path" (which flows?)
  - "harmless Bedrock read" (say "read-only Bedrock call")

---

## Traceability

| Item | Implementation readiness | Codebase details | Style |
|---|---|---|---|
| B1 | Major 1 | Blocker 1 | F1 |
| B2 | Blocker 1 | Major 5 | - |
| B3 | Blocker 2 | - | - |
| B4 | Nit 1 | Blocker 3 | F3 |
| M1 | Major 2 | Blocker 2, Major 1, Major 8 | F2 |
| M2 | Nit 6 | Major 2 | - |
| M3 | Major 6 | Major 3, Nit 5 | - |
| M4 | Major 3 | Nit 1, Nit 2 | F5 |
| M5 | Major 4 | Major 7 | - |
| M6 | Major 5 | Nit 4 | F6 |
| M7 | Major 7 | Major 6 | - |
| M8 | Major 8 | - | - |
| M9 | Major 9 | - | - |
| M10 | Major 10, Nit 2 | Major 4 | F4 |
| N1 | Major 11 | Nit 6 | F8 |
| N2 | - | - | F9 |
| N3 | Nit 3 | Nit 3 | - |
| N4, N5 | Nit 4, Nit 5 | - | - |
| N6 | - | - | F7 |
| N7 | Nit 7 | - | - |
| N8-N10 | - | - | F8, F4 |

Some things the plan names were checked and found to exist as described:
- in `iamauth.go`: `awsCreds`, `loadCreds`, `sha256Hex`, `hmacSHA256` and `presign`
- `Verify` with a scope string
- the CORS header line at `middleware.go:39`
- `UpsertCognitoUser`
- migrations run on every start
- `gen_random_uuid()`
- `aws_iam_role.api_task`
- the `oxlint` lint script
- `ProtectedRoute`
- the segment and thumbnail filenames, which match the allowlist
