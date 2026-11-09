# Walkthrough: building the video pipeline on AWS

This guide explains what was built, why each piece exists, and how to build
it yourself. Each AWS service has two ways to set it up:

- **Console:** click-paths and the exact settings used in this project.
  Learn each service this way first.
- **Terraform:** the file in `infra/` that creates the same thing. Use it
  once you understand the service, so the whole stack can come up and go
  away with one command.

The sections follow the order things were built. Each section ends with a
way to check it works. Sections are added as each build step is finished.

> The AWS Console changes its layout from time to time. If a button has
> moved, look for the same setting name nearby; the values stay the same.

| Build step | Sections | Status |
|---|---|---|
| Foundation | 0-3 | Done |
| Step 1: worker on AWS | 4-10 | Done |
| Step 2: Bedrock summary | 11 | Done |
| Step 3: results page | 12 | Done |
| Step 4: Aurora and video status | 13 | Done |
| Step 5: app on ECS, Lambda fan-out | 14 | Done |
| Steps 6-8 | - | Not started |

## The big picture

```text
browser -> API (Go) -> writes video to a folder that is really S3 (Mountpoint)
                       then writes an empty "<video>.done" file next to it
S3 "Object Created" for *.done -> EventBridge rule -> Step Functions pipeline:
   1. ECS task on an EC2 instance: Go worker runs ffmpeg + whisper.cpp
   2. Rekognition finds labels in the video
   3. Bedrock (Nova Lite) writes a summary, chapters and tags
   4. SNS sends an email
```

Three rules shape every choice:

1. **Serverful:** our code runs on EC2 instances we size, managed by ECS.
2. **No AWS SDK in our code:** AWS services call each other, set up in
   Terraform. Our Go code only does HTTP, SQL and files.
3. **Spend only Free plan credits:** the account stays on the AWS Free plan.
   MediaConvert and Transcribe are blocked on that plan, so our own worker
   does transcoding (ffmpeg) and transcription (whisper.cpp).

---

## 0. Before you start

**Tools on your computer:** AWS CLI v2, Terraform 1.6 or newer, Docker, Go
1.26, Node 22.

**AWS CLI login:** `aws configure` with an IAM user or SSO profile, region
`ap-south-1` (Mumbai). Check it:

```bash
aws sts get-caller-identity
```

**Check your plan and credits** (do this often):

```bash
aws freetier get-account-plan-state --region us-east-1
```

On the Free plan you cannot be charged money. The risk is running out of
credits: when they run out or expire, AWS closes the account. Anything that
bills by the hour while idle (NAT Gateway, load balancer, database, running
EC2) burns credits even when nobody uses it, so only keep those up while
you work.

**Before adding any AWS service,** check it works on the Free plan with a
harmless read call. Example from this project:

```bash
aws mediaconvert list-queues --region ap-south-1
```

`SubscriptionRequiredException` means the plan blocks that service.

**Names used everywhere:** the prefix `videointell`, region `ap-south-1`.

---

## 1. The app on your computer

**What:** a Go (Gin) API with Postgres, a React frontend, and file storage.

**Why it looks the way it does:**

- **Files, not S3 calls.** The API only reads and writes files under
  `LOCAL_DATA_DIR`. Locally that is `backend/data/`. On AWS it is
  `/mnt/videos`, which Mountpoint for S3 turns into the S3 bucket. So the
  same code works in both places with no AWS SDK.
- **Signed file URLs.** Upload and playback links look like
  `/api/files/<key>?exp=...&sig=...`. The signature is an HMAC-SHA256 of
  the method, the file key and the expiry time, made with `JWT_SECRET`.
  Uploads last 15 minutes, playback 1 hour. Changing anything in the link
  gives a 403. Code: `backend/internal/storage/local.go`.
- **The `.done` marker.** After the file is fully written, the API sets the
  status to `uploaded` and writes an empty `<key>.done` file. Only the
  marker starts the pipeline, so a cut-off upload never gets processed.
- **One function owns video status.** `set_video_status(key, from, to,
  results)` in `backend/internal/db/migrations/0002_video_status.sql`
  only changes a row if its current status is in the allowed list. Late or
  duplicate updates do nothing.
- **Safe filenames.** Upload names are cleaned to `A-Z a-z 0-9 . _ -` so S3
  keys never need URL encoding inside events.

**Run it:** see "Running locally" in the README.

**Check it:** register, upload a video, and see it under
`backend/data/uploads/<user>/` with a `.done` file next to it.

---

## 2. S3 bucket

**What:** one bucket holds everything. `uploads/` has the original videos
and their `.done` markers; `processed/` has the results.

### Console

1. **S3 -> Create bucket**
   - Bucket type: **General purpose**
   - Name: `videointell-uploads-<account-id>-ap-south-1-an` (any globally
     unique name works)
   - Region: **Asia Pacific (Mumbai) ap-south-1**
   - Object Ownership: **ACLs disabled (Bucket owner enforced)**
   - Block Public Access: **Block all public access** ticked
   - Bucket Versioning: **Disable**
   - Default encryption: **SSE-S3**, Bucket Key **Enable**
   - **Create bucket**
2. **Lifecycle rule** (keeps test uploads from piling up): open the bucket
   -> **Management -> Create lifecycle rule**
   - Name: `expire-test-uploads`
   - Scope: **Limit the scope using filters**, Prefix `uploads/`
   - Actions: tick **Expire current versions of objects** and **Delete
     expired object delete markers or incomplete multipart uploads**
   - Days after object creation: `3`
   - Delete incomplete multipart uploads after: `1` day
3. **Send events to EventBridge:** bucket -> **Properties -> Amazon
   EventBridge -> Edit -> On -> Save changes**. This sends every object
   event to EventBridge, where rules pick the ones they want.

### Terraform

`infra/s3.tf`. The bucket was first made in the Console, so the file uses
`import` blocks to take it over without recreating it, and
`prevent_destroy` so `terraform destroy` cannot delete it by accident.
`aws_s3_bucket_notification` with `eventbridge = true` is step 3 above.

### Check it

```bash
aws s3api get-bucket-notification-configuration --bucket <bucket>
```

The output should contain `"EventBridgeConfiguration": {}`.

---

## 3. EventBridge rule

**What:** a rule that matches "a `.done` file appeared under `uploads/`"
and starts the pipeline. A CloudWatch log group is a second target so you
can see every matched event.

### Console

1. **CloudWatch -> Log groups -> Create log group**
   - Name: `/aws/events/videointell-video-uploaded`
   - Retention: **1 week**
2. **EventBridge -> Rules -> Create rule**
   - Name: `videointell-video-uploaded`
   - Event bus: **default**
   - Rule type: **Rule with an event pattern**
   - Event source: **AWS events or EventBridge partner events**
   - Creation method: **Custom pattern (JSON editor)**, paste:

     ```json
     {
       "source": ["aws.s3"],
       "detail-type": ["Object Created"],
       "detail": {
         "bucket": { "name": ["<bucket>"] },
         "object": { "key": [{ "wildcard": "uploads/*.done" }] }
       }
     }
     ```

   - Target 1: **AWS service -> CloudWatch log group**, pick the log group
     above. The Console adds the log permission for you.
   - Target 2 (after section 10 exists): **AWS service -> Step Functions
     state machine -> `videointell-pipeline`**, Execution role **Create a
     new role for this specific resource**.
   - **Create rule**

**Why `wildcard`:** EventBridge has `prefix` and `suffix` matching, but two
conditions on the same field are an OR, not an AND. `uploads/*.done` needs
both, and one wildcard pattern does that.

### Terraform

`infra/eventbridge.tf`: the rule, the log group with its resource policy
(`aws_cloudwatch_log_resource_policy`, which the Console adds silently),
the log target, and the Step Functions target with its role.

### Check it

```bash
aws s3api put-object --bucket <bucket> --key uploads/test/a.mp4.done
aws logs tail /aws/events/videointell-video-uploaded --since 5m --region ap-south-1
```

You should see one event with `"key": "uploads/test/a.mp4.done"`.

---

## 4. SNS topic

**What:** the topic the pipeline publishes "Video processed" and "Video
processing failed" messages to, with your email subscribed.

### Console

1. **SNS -> Topics -> Create topic**
   - Type: **Standard**
   - Name: `videointell-notifications`
   - **Create topic**
2. In the topic: **Create subscription**
   - Protocol: **Email**
   - Endpoint: your email address
   - **Create subscription**, then click the link in the email AWS sends.

### Terraform

`infra/sns.tf`. The email subscription is only created when you set
`alert_email` in `infra/terraform.tfvars` (git-ignored):

```bash
echo 'alert_email = "you@example.com"' > infra/terraform.tfvars
```

### Check it

**Topic -> Publish message**, type anything, **Publish**. The email arrives
within a minute.

---

## 5. Network (VPC)

**What:** a VPC with two public subnets in two zones, an internet gateway,
and a free S3 gateway endpoint. **No NAT Gateway**: it bills every hour
(the biggest idle cost in a typical VPC). Worker instances get a public IP
instead, and their security group allows no inbound traffic at all.

### Console

1. **VPC -> Create VPC -> VPC and more**
   - Name tag auto-generation: `videointell`
   - IPv4 CIDR: `10.0.0.0/16`
   - Number of Availability Zones: **2**
   - Number of public subnets: **2**, private subnets: **0**
   - NAT gateways: **None**
   - VPC endpoints: **S3 Gateway**
   - DNS hostnames and DNS resolution: both ticked
   - **Create VPC**
2. For each of the two public subnets: **Subnets -> select -> Actions ->
   Edit subnet settings -> Enable auto-assign public IPv4 address -> Save**.
3. **EC2 -> Security Groups -> Create security group**
   - Name: `videointell-worker`
   - Description: `Worker instances: no inbound, all outbound`
   - VPC: `videointell`
   - Inbound rules: **none**
   - Outbound rules: keep the default **All traffic to 0.0.0.0/0**

**Why the S3 endpoint:** video bytes between the instance and S3 go through
it instead of the internet gateway. It is free and keeps that traffic inside
AWS.

### Terraform

`infra/network.tf`.

### Check it

**VPC -> Route tables -> the public table -> Routes:** `0.0.0.0/0 -> igw-...`
and a `pl-...` (S3 prefix list) route to `vpce-...`.

---

## 6. Container images and ECR

**What:** three Dockerfiles, and an ECR repository for the worker image.

| Image | File | Inside |
|---|---|---|
| API | `backend/Dockerfile` | Static Go binary on distroless, runs as non-root |
| Worker | `backend/Dockerfile.worker` | Go worker, ffmpeg, whisper.cpp v1.9.5 built from source, the whisper `base` model (about 142 MB), runs as user 65532 |
| Web | `frontend/Dockerfile` | React build served by Nginx, with a fallback to `index.html` for app routes |

The worker image is built in three stages: one compiles the Go worker, one
compiles whisper.cpp and downloads the model, and the last one copies only
the finished files onto a slim Debian image with ffmpeg.

### Console

1. **ECR -> Private registry -> Repositories -> Create repository**
   - Name: `videointell-worker`
   - Tag mutability: **Mutable**
   - **Create**
2. In the repository: **Lifecycle Policy -> Create rule**
   - Rule priority: `1`
   - Description: `Keep the last 5 images`
   - Image status: **Any**
   - Match criteria: **Image count more than** `5`
   - **Save**
3. **View push commands** shows the login, build, tag and push commands.

### Push the image

```bash
REPO=$(terraform -chdir=infra output -raw worker_repository)
aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin ${REPO%%/*}
docker build -t $REPO:latest -f backend/Dockerfile.worker backend
docker push $REPO:latest
```

### Terraform

`infra/ecr.tf`. `force_delete = true` lets the final teardown remove the
repository even with images in it.

### Check it locally first

```bash
docker run --rm -v /tmp/vi-data:/mnt/videos -e VIDEO_KEY=uploads/u1/1-test.mp4 videointell-worker:dev
```

---

## 7. IAM roles

**What:** each part gets its own role with only the permissions it needs.

| Role | Used by | Permissions |
|---|---|---|
| `videointell-worker-instance` | EC2 worker instances | ECS agent, Session Manager, and S3 read/write on the bucket for Mountpoint |
| `videointell-task-execution` | ECS, to start the container | Pull the image from ECR, write logs |
| `videointell-pipeline` | Step Functions | Run the worker task, Rekognition, Bedrock, S3 read/write on `processed/*`, publish to SNS |
| `videointell-events-start-pipeline` | EventBridge | Start the state machine |

### Console: worker instance role

1. **IAM -> Roles -> Create role**
   - Trusted entity: **AWS service**, Use case **EC2**
   - Permissions: `AmazonEC2ContainerServiceforEC2Role` and
     `AmazonSSMManagedInstanceCore`
   - Name: `videointell-worker-instance`
   - **Create role** (the Console also creates an instance profile with the
     same name)
2. Open the role -> **Add permissions -> Create inline policy -> JSON**:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": "s3:ListBucket",
         "Resource": "arn:aws:s3:::<bucket>" },
       { "Effect": "Allow",
         "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
         "Resource": "arn:aws:s3:::<bucket>/*" }
     ]
   }
   ```

   Name it `mountpoint-s3`.

### Console: task execution role

**IAM -> Roles -> Create role -> AWS service -> Elastic Container Service ->
Elastic Container Service Task**, attach `AmazonECSTaskExecutionRolePolicy`,
name `videointell-task-execution`.

The pipeline role is easiest to let the Step Functions Console create
(section 10), then add the missing permissions listed there.

### Terraform

`infra/ecs.tf` (instance and execution roles), `infra/stepfunctions.tf`
(pipeline role), `infra/eventbridge.tf` (events role).

---

## 8. Worker instances: launch template, Auto Scaling group, ECS cluster

**What:** an ECS cluster whose only capacity is an Auto Scaling group of
0 to 1 `c7i-flex.large` instances (2 vCPU, 4 GB, eligible on the Free
plan). ECS starts an instance when a task needs one, and removes it about
15 minutes after the last task ends. Idle cost is zero.

Each instance mounts the bucket at `/mnt/videos` with Mountpoint for S3
when it boots, before it joins the cluster.

### Console

1. **Find the ECS-optimized AMI ID** (it changes over time):

   ```bash
   aws ssm get-parameter --region ap-south-1 --name /aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id --query Parameter.Value --output text
   ```

2. **EC2 -> Launch templates -> Create launch template**
   - Name: `videointell-worker`
   - AMI: **Browse more AMIs**, paste the AMI ID
   - Instance type: `c7i-flex.large`
   - Key pair: **Don't include** (Session Manager is used instead of SSH)
   - Security groups: `videointell-worker`
   - Advanced details:
     - IAM instance profile: `videointell-worker-instance`
     - Metadata version: **V2 only (token required)**
     - User data:

       ```bash
       #!/bin/bash
       set -euxo pipefail
       dnf install -y https://s3.amazonaws.com/mountpoint-s3-release/latest/x86_64/mount-s3.rpm
       echo user_allow_other >> /etc/fuse.conf
       mkdir -p /mnt/videos
       mount-s3 <bucket> /mnt/videos --region ap-south-1 --allow-other --allow-delete --uid 65532 --gid 65532 --dir-mode 0755 --file-mode 0644
       echo ECS_CLUSTER=videointell >> /etc/ecs/ecs.config
       ```

   - **Create launch template**

   What the user data does: installs Mountpoint, lets containers see the
   mount (`--allow-other`), makes files appear owned by user 65532 (the
   worker container's user), mounts the bucket, and only then tells the ECS
   agent which cluster to join.
3. **EC2 -> Auto Scaling groups -> Create Auto Scaling group**
   - Name: `videointell-worker`
   - Launch template: `videointell-worker`, Version **Latest**
   - VPC: `videointell`, both public subnets
   - Load balancing: **No load balancer**
   - Desired `0`, Minimum `0`, Maximum `1`
   - Tags: `AmazonECSManaged` = `true`
   - **Create Auto Scaling group**
4. **ECS -> Clusters -> Create cluster**
   - Name: `videointell`
   - Infrastructure: create it without Fargate or new EC2 capacity if the
     Console allows; otherwise accept the default and ignore it
   - **Create**
5. In the cluster: **Infrastructure -> Capacity providers -> Create**
   - Name: `videointell-worker`
   - Auto Scaling group: `videointell-worker`
   - Managed scaling: **On**, Target capacity `100`%
   - Managed termination protection: **Off**
   - **Create**

### Terraform

`infra/ecs.tf`: `aws_launch_template`, `aws_autoscaling_group`,
`aws_ecs_cluster`, `aws_ecs_capacity_provider`,
`aws_ecs_cluster_capacity_providers`.

### Check it

After a pipeline run starts: **EC2 -> Instances** shows
`videointell-worker` running, and **ECS -> Clusters -> videointell ->
Infrastructure** shows one container instance. To look inside:

**EC2 -> instance -> Connect -> Session Manager -> Connect**, then:

```bash
mount | grep mountpoint
ls /mnt/videos
```

---

## 9. ECS task definition

**What:** how to run the worker container: image, CPU and memory, the
mounted folder, env vars and logs.

### Console

1. **CloudWatch -> Log groups -> Create log group:**
   `/ecs/videointell-worker`, retention **1 week**.
2. **ECS -> Task definitions -> Create new task definition**
   - Family: `videointell-worker`
   - Launch type: **Amazon EC2 instances**
   - Network mode: **bridge**
   - Task execution role: `videointell-task-execution`
   - Container:
     - Name: `worker`
     - Image URI: `<account-id>.dkr.ecr.ap-south-1.amazonaws.com/videointell-worker:latest`
     - Essential: **Yes**
     - CPU: `2` vCPU (2048 units), Memory hard limit: `3` GB
     - Environment variables: `LOCAL_DATA_DIR` = `/mnt/videos`,
       `REQUIRE_MOUNT` = `true`
     - Logging: **awslogs**, group `/ecs/videointell-worker`, region
       `ap-south-1`, stream prefix `worker`
   - Storage -> **Add volume**: name `videos`, type **Bind mount**, source
     path `/mnt/videos`
   - Container mount point: volume `videos`, container path `/mnt/videos`
   - **Create**

`VIDEO_KEY` is not set here. Step Functions passes it for each video.

**Why `REQUIRE_MOUNT=true`:** if Mountpoint failed at boot, `/mnt/videos`
would be a plain folder on the instance disk, and results would silently
never reach S3. With this set, the worker refuses to start instead.

### Terraform

`infra/ecs.tf`: `aws_ecs_task_definition.worker` and the log group.

---

## 10. Step Functions pipeline

**What:** a Standard state machine started by the EventBridge rule. It uses
**JSONata** expressions (`{% ... %}`) to read and shape data.

```text
Init                 work out the video key and the processed/ folder
ProcessVideo         run the worker task on ECS and wait for it to finish
StartLabelDetection  Rekognition on processed/.../video.mp4
WaitForLabels        wait 20 s
GetLabels            ask for the result (loop until SUCCEEDED or FAILED)
SaveLabels           write labels.json
Summarize            Bedrock (see section 11)
SaveSummary          write summary.json
NotifyReady          SNS "Video processed"

Any error -> NotifyFailed (SNS "Video processing failed") -> Failed
Throttling errors are retried up to 6 times with growing waits first.
```

**How `Init` gets the key:** the event key is `uploads/<user>/<file>.done`.
`Init` drops the last 5 characters (`.done`) to get the video key, and
builds `processed/<user>/<file>/` as the output folder. These become
variables (`$videoKey`, `$out`, `$bucket`) that later states read.

**Why `.sync` for ECS:** `arn:aws:states:::ecs:runTask.sync` makes Step
Functions wait until the container exits. Exit code 0 continues; anything
else goes to `NotifyFailed`. The task asks for the `videointell-worker`
capacity provider, so if no instance is running, the task waits in
`PROVISIONING` while ECS starts one.

**Why Rekognition polls:** Rekognition video jobs have no `.sync` option,
so the state machine starts the job, waits, checks, and loops.

**Why only 200 labels:** the result passes through the state, which is
limited to 256 KB. 200 labels stays well under that.

### Console

1. **Step Functions -> State machines -> Create state machine -> Blank**
2. Switch to the **Code** tab and paste the definition. Get the exact
   definition from the deployed state machine:

   ```bash
   aws stepfunctions describe-state-machine --region ap-south-1 --state-machine-arn <arn> --query definition --output text > pipeline.json
   ```

3. **Config** tab:
   - Name: `videointell-pipeline`
   - Type: **Standard**
   - Execution role: **Create new role**
4. **Create**. Then open the new role in IAM and add an inline policy so it
   can do everything the pipeline needs:
   - `ecs:RunTask` on the task definition, `ecs:StopTask`,
     `ecs:DescribeTasks`
   - `iam:PassRole` on `videointell-task-execution`
   - `events:PutTargets`, `events:PutRule`, `events:DescribeRule` on the
     rule `StepFunctionsGetEventsForECSTaskRule` (this is how `.sync`
     hears that the task ended)
   - `rekognition:StartLabelDetection`, `rekognition:GetLabelDetection`
   - `s3:GetObject`, `s3:PutObject` on `<bucket>/processed/*`
   - `bedrock:InvokeModel` (section 11)
   - `sns:Publish` on the topic
5. Add the state machine as the second target of the EventBridge rule
   (section 3).

### Terraform

`infra/stepfunctions.tf`: the full definition as HCL, and the role with
exactly the permissions above.

### Check it end to end

```bash
B=<bucket>
aws s3 cp test.mp4 s3://$B/uploads/u1/1-test.mp4
aws s3api put-object --bucket $B --key uploads/u1/1-test.mp4.done
aws logs tail /ecs/videointell-worker --follow --region ap-south-1
```

**Step Functions -> videointell-pipeline -> Executions** shows the run, and
the graph view highlights each step. Measured in this project: about
3.5 minutes when the instance starts from zero, about 40 seconds when one
is already running. Results appear under `processed/u1/1-test.mp4/`:
`hls/`, `thumbs/`, `video.mp4`, `transcript.json`, `transcript.vtt`,
`bedrock-request.json`, `labels.json`.

---

## 11. Bedrock summary (step 2)

**What:** Amazon Nova Lite reads the transcript and returns a summary,
chapters with start times, and tags, saved as `summary.json`.

**How the data flows:**

1. The worker writes `bedrock-request.json`: a Nova request (`messages`
   plus `inferenceConfig`) with the timestamped transcript and
   instructions to reply with only JSON.
2. The `Summarize` state calls Bedrock with `Input.S3Uri` pointing at that
   file, so a long transcript never passes through the 256 KB state.
3. The reply is small, so it comes back into the state. JSONata reads
   `output.message.content[0].text`, trims it, removes any code fences,
   and parses the JSON with `$parse`.
4. `SaveSummary` writes it to `summary.json`.

**Model:** the inference profile `apac.amazon.nova-lite-v1:0`. It routes
requests across six Asia Pacific regions, so the pipeline role may call
`bedrock:InvokeModel` on that profile and on the Nova Lite model in any
region (the model is pinned, the region is `*`).

**Why not Claude:** Anthropic models on Bedrock are sold through AWS
Marketplace and need a payment method on the account. On the Free plan
the Marketplace agreement is created and then terminated within seconds
(AWS sends an "agreement expired" mail), and calls fail with
`INVALID_PAYMENT_INSTRUMENT`. Nova is Amazon's own model, has no
Marketplace agreement, and is paid from Free plan credits.

### Console

1. **Check Bedrock works on your plan** with one tiny call:

   ```bash
   echo '{"messages":[{"role":"user","content":[{"text":"Reply with the word ok."}]}],"inferenceConfig":{"maxTokens":20}}' > ok.json
   aws bedrock-runtime invoke-model --region ap-south-1 --model-id apac.amazon.nova-lite-v1:0 --content-type application/json --body fileb://ok.json out.json && cat out.json
   ```

2. No model access form is needed for Nova.
3. Add `bedrock:InvokeModel` to the pipeline role (section 10).

### Terraform

`infra/stepfunctions.tf`: the `bedrock_profile` variable, the `Summarize`
and `SaveSummary` states, and the Bedrock statement in the role.

### Check it

Run the pipeline (section 10), then:

```bash
aws s3 cp s3://<bucket>/processed/u1/1-test.mp4/summary.json -
```

The test video has no speech, so the result is
`{"summary":"","chapters":[],"tags":[]}`. A video with speech fills all
three fields. The run status is SUCCEEDED, and the graph view shows
`Summarize` and `SaveSummary` in green.

Rerunning the same video fails in `ProcessVideo` with `file exists`: the
worker never overwrites files under `processed/`. Delete the old results
first:

```bash
aws s3 rm --recursive s3://<bucket>/processed/u1/1-test.mp4/
aws s3api put-object --bucket <bucket> --key uploads/u1/1-test.mp4.done
```

---

## 12. Results page (step 3)

**What:** the video page plays the HLS stream and shows the summary,
chapters, tags and Rekognition labels. No AWS setup in this step: it is
app code only (Go API and React).

**How the files reach the browser:**

1. The video detail call (`GET /api/videos/:id`) returns `results_url`:
   `/api/results/<exp>/<sig>/processed/<user>/<file>/`. The signature
   covers the whole results folder of that one video and lasts one hour.
2. The signature sits in the path, not in `?sig=`, because the HLS
   playlists point at their segments with relative links. A relative link
   keeps the path but drops the query, so a path signature still works on
   every segment.
3. `GET /api/results/...` cleans the path, takes the first three parts
   (`processed/<user>/<file>/`) as the folder, checks the signature for
   that folder, and serves the file. `..` cannot leave the folder, and a
   signature for one video does not open another.
4. The page reads `summary.json` and `labels.json` from that folder. Until
   they exist it shows a shimmer and asks again every 10 seconds, playing
   the original upload meanwhile. Once they exist it plays
   `hls/master.m3u8` (hls.js where the browser cannot play HLS itself),
   uses `thumbs/thumb_01.jpg` as the poster and `transcript.vtt` as
   captions.

**Layout:** a dark "cinema" page: the player on a soft glow made from a
blurred poster, a chapter strip below it (one thumbnail card per chapter,
picked from the 10-second thumbnails), then summary, tags and labels cards.

**Motion:** the chapter matching the play position is highlighted, its
progress bar fills as it plays, and it is scrolled into view; clicking a
chapter jumps there. Results fade in after
the shimmer. Both turn off under reduced motion.

**Later:** in step 7 CloudFront signed cookies replace the path signature,
and in step 4 the status badge starts showing `processing` and `ready`.

### Check it

Run the API and frontend (section 1), open a video that has
`processed/<user>/<file>/summary.json`, then click a chapter: the player
jumps and the chapter is highlighted. `go test ./internal/handlers/` checks
that the results route refuses other folders and `..`.

---

## 13. Aurora and video status (step 4)

**What:** an Aurora PostgreSQL Serverless v2 database holds users and
videos. The pipeline changes a video's status through the RDS Data API,
always by calling one function, `set_video_status(key, from, to, results)`,
which only changes the row if its current status is in `from`.

**Free plan limits:** only "express configuration" clusters are allowed:
up to 4 ACU, 1 GB storage, 2 clusters. An express cluster has no VPC: it
is reached through Aurora's internet access gateway, over TLS, and its
admin user signs in with IAM tokens only (no password). The Data API needs
a separate password user, kept in Secrets Manager.

**Cost:** billed per ACU-hour only while awake (roughly $0.15 per ACU-hour,
estimate). It pauses after 5 minutes idle; the first call after a pause
takes about 15 seconds and the pipeline retries
`RdsData.DatabaseResumingException`.

### Console

1. **RDS** (ap-south-1) -> **Databases** -> **Create with express
   configuration** -> **Create**. Capacity range 0 to 4 ACU. Wait for
   **Available**. (This project's cluster kept the default name
   `database-1`.)
2. The Data API is turned on by Terraform below (Console: **Modify** ->
   **RDS Data API**).

### Terraform

`infra/database.tf`: `import` blocks bring the Console cluster and its
instance under Terraform (the AWS provider cannot create express clusters).
It turns on the Data API, keeps 0 to 4 ACU with a 5 minute auto-pause, and
creates the `videointell/pipeline-db` secret with a random password.

`infra/stepfunctions.tf`: three Data API states call
`arn:aws:states:::aws-sdk:rdsdata:executeStatement`:

| State | SQL | After |
|---|---|---|
| `MarkProcessing` | `uploaded -> processing` | `false` means another run has it or the row is missing: stop with `AlreadyHandled` |
| `MarkReady` | `processing -> ready`, results `{"prefix": ...}` | SNS "Video processed" |
| `MarkFailed` | `uploaded, processing -> failed` | SNS failure email (every `Catch` goes here first) |

The role may call `rds-data:ExecuteStatement` on the cluster and
`secretsmanager:GetSecretValue` on the one secret.

### Database setup (one time)

`infra/db-setup.sql` creates the `videointell` database, runs the app
migrations and creates the `pipeline` user. Run it as `postgres` with an
IAM token (made on your machine, valid 15 minutes):

```bash
cd infra
H=<cluster endpoint>
PGPASSWORD="$(aws rds generate-db-auth-token --hostname $H --port 5432 --username postgres --region ap-south-1)" \
  psql "host=$H dbname=postgres user=postgres sslmode=require" \
  -v pw="$(aws secretsmanager get-secret-value --secret-id videointell/pipeline-db --region ap-south-1 --query SecretString --output text | python3 -c 'import sys,json;print(json.load(sys.stdin)["password"])')" \
  -f db-setup.sql
```

### Check it

Add a row with status `uploaded` for the test key, run the pipeline
(section 10), then:

```bash
aws rds-data execute-statement --region ap-south-1 --resource-arn <cluster arn> \
  --secret-arn <secret arn> --database videointell \
  --sql "SELECT status, results::text FROM videos WHERE original_key = 'uploads/u1/1-test.mp4'"
```

Measured: `ready` with `{"prefix": "processed/u1/1-test.mp4/"}`.

---

## 14. App on ECS and Lambda fan-out (step 5)

**What:** the API and the Nginx frontend run on ECS behind an ALB, in their
own Terraform folder `infra/app/` so the hourly parts can be destroyed on
their own. Processing moved from an EC2 worker to Lambda workers run in
parallel by a Step Functions Distributed Map.

**Why Lambda:** the EC2 worker needed about 3.5 minutes to start an
instance for every video and handled one video per instance. Lambda starts
in seconds, costs nothing when idle, and runs one function per 30-second
chunk, so a long video finishes about as fast as a short one. Measured:
58 s for the test clip, against about 220 s before.

**How the pipeline runs now:**

1. `Split` (Lambda): downloads the upload, `ffmpeg -c copy -f segment` cuts
   it into 30 s chunks at keyframes (no re-encode) and saves them under
   `work/` (deleted by an S3 lifecycle rule after one day).
2. `Chunks` (Distributed Map, up to 1,000 at once, child workflows of type
   STANDARD so a slow chunk is not cut at 5 minutes): one Lambda per chunk
   makes the HLS segments, the thumbnails that fall in its time range and
   the whisper transcript, shifted to the chunk's start.
3. `Assemble` (Lambda): joins the per-chunk playlists with
   `#EXT-X-DISCONTINUITY` between chunks, joins the transcripts, and writes
   `transcript.vtt` and `bedrock-request.json`.
4. In parallel with 1 to 3, Rekognition reads the original upload.

**API to Aurora:** the API connects as the `api` database user. For each
new connection it signs an IAM token itself (SigV4 with the Go standard
library, checked against AWS's published example) using the ECS task
role's credentials from the container credentials endpoint.

**Cost:** the app stack bills by the hour (ALB about $0.023/h, `t3.small`
about $0.022/h, 3 public IPv4 addresses $0.015/h; about $0.06/h in all,
estimates). Lambda costs only while it runs (roughly 1 cent per minute of
video at 10 GB, estimate).

### Console

- **Lambda** -> **Create function** -> **Container image**, the
  `videointell-worker` image, x86_64; **Configuration** -> memory 10240 MB,
  ephemeral storage 10240 MB, timeout 15 min, env `CHUNK_SECONDS=30`.
- **Step Functions**: in Workflow Studio, a **Parallel** state with a
  **Map** state set to **Distributed**, child execution type **Standard**,
  max concurrency 1000.

### Terraform

- `infra/lambda.tf`: the worker function (pinned to the image digest), its
  role (read `uploads/*` and `work/*`, write `work/*` and `processed/*`),
  log group, and the ECR policy that lets Lambda pull the image.
- `infra/stepfunctions.tf`: the `Process` Parallel state with the Map;
  the role may start and stop its own child executions and invoke the
  function.
- `infra/app/`: ALB, target groups (`/api/*` to the API, the rest to
  Nginx), API Auto Scaling group with Mountpoint, ECS services, the JWT
  secret in SSM Parameter Store, and the task role allowed
  `rds-db:connect` as `api`.

```bash
terraform -chdir=infra/app apply     # start of a session
terraform -chdir=infra/app destroy   # end of a session
```

### Check it

Upload a video in the app, or reset the test row to `uploaded` and write
the `.done` marker (section 13), then:

```bash
aws stepfunctions list-executions --region ap-south-1 --state-machine-arn <pipeline arn> \
  --max-results 1 --query "executions[0].[status,startDate,stopDate]" --output text
```

**Limits:** whisper hears each chunk on its own, so a word cut at a chunk
edge can come out wrong. The split Lambda keeps the upload and its chunks
in its 10 GB `/tmp`, so uploads above about 4.5 GB fail there.
