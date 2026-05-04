# Handoff — Mike AWS deployment setup

**Branch:** `claude/setup-supabase-integration-aCV7X`
**Resuming on:** EC2 dev instance (was previously a sandbox without docker daemon access)
**Today's date when paused:** 2026-05-04

## What we're doing

Deploying Mike (forked from upstream) for an internal team. Upstream targets
Cloudflare; we're targeting AWS instead. Region: **`ap-southeast-2` (Sydney)**.

Architecture:

| Component | Service |
|---|---|
| Database + auth | Supabase (Sydney) |
| File storage | AWS S3 |
| Backend (Express + LibreOffice) | **ECS Fargate behind an ALB** (App Runner is deprecated for new customers as of 2026-04-30) |
| Frontend (Next.js) | AWS Amplify |
| Image registry | ECR |
| Secrets | AWS Secrets Manager |
| Domains / certs | Route 53 + ACM (us-east-1 for Amplify, ap-southeast-2 for ALB) |

## Identifiers (not secret — fine to paste)

- **AWS account:** `711472107944`
- **Region:** `ap-southeast-2`
- **S3 bucket:** `wrmk-mike-prod` (private, versioning on, SSE-S3)
- **ECS task role:** `arn:aws:iam::711472107944:role/mike-ecs-task-role`
  - Inline policy `mike-ecs-task-policy`: S3 GetObject/PutObject/DeleteObject on `wrmk-mike-prod/*`, plus `secretsmanager:GetSecretValue` on `mike/*`.
- **Local dev IAM user:** `mike-dev-local`
  - Inline policy `mike-ecs-dev-policy`: S3 GetObject/PutObject/DeleteObject on `wrmk-mike-prod/*`.
  - User has captured the access keys.
- **Supabase project:** `https://xivirpdpcnaqbomqdzyy.supabase.co` (region: Sydney)
  - Schema migration `backend/migrations/000_one_shot_schema.sql` ran cleanly. Tables present.
  - User has captured the publishable + secret API keys (new format, `sb_publishable_…` / `sb_secret_…`) out of band.

## Repo changes already made on this branch

1. **`backend/src/lib/storage.ts`** patched to support both R2 and AWS S3.
   - Endpoint and explicit credentials now optional.
   - Region read from `R2_REGION` → `AWS_REGION` → `"auto"`.
   - On ECS, just set `R2_BUCKET_NAME` + `R2_REGION=ap-southeast-2` and the SDK picks up the task role via the default credential provider chain.
2. **`backend/.env.example`** updated to reflect the new optional env shape.
3. **`backend/Dockerfile`** added — multi-stage Node 22 + LibreOffice (writer only) + tini, runs as non-root `node` user. TypeScript build verified locally.
4. **`backend/.dockerignore`** added — keeps build context to source + lock files.

## Step status

- [x] Step 1: Supabase project + migration + API keys captured
- [x] Step 2: S3 bucket + IAM (ECS task role + dev IAM user)
- [x] Patch `backend/src/lib/storage.ts` for AWS S3
- [ ] **Step 3: Backend Dockerfile + ECR push** ← resume here
- [ ] Step 4: ECS Fargate cluster + task def + service + ALB
- [ ] Step 5: Amplify deploy of frontend (root `frontend/`, four env vars)
- [ ] Step 6: Route 53 + ACM (us-east-1 for Amplify, ap-southeast-2 for ALB) + `FRONTEND_URL`/CORS
- [ ] Step 7: End-to-end test (signup, upload, chat, generate, SSE)

## Next concrete actions (Step 3, on the EC2)

User has decided to deploy from a dev EC2 rather than their laptop — better network to ECR, can use instance profile instead of access keys.

### Open questions to ask the user when they reconnect

1. **EC2 architecture?** (`uname -m` — `x86_64` vs `aarch64`). Determines whether we keep `--platform linux/amd64` in the docker build, or build native and switch Fargate to ARM64 (~20% cheaper).
2. **Does the EC2 already have an instance role attached?** If yes, we add the deploy policy to it. If no, create one and attach.
3. **Will they `git clone` the repo onto the EC2** to build there? (Recommended.)

### Permissions to add to the EC2 instance role (for Step 3 only)

Inline policy `mike-deploy-policy`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EcrPushPull",
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:CreateRepository",
        "ecr:DescribeRepositories",
        "ecr:DescribeImages",
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage"
      ],
      "Resource": "*"
    }
  ]
}
```

We'll widen this for Step 4 (ECS, ALB, IAM:PassRole, logs) — keeping minimum-per-step.

### Commands to run on the EC2

```bash
# Prereqs
docker --version && aws --version && git --version
sudo systemctl enable --now docker
sudo usermod -aG docker $USER  # then re-login

# Clone the repo and check out the working branch
git clone <your-fork-url> mike && cd mike
git checkout claude/setup-supabase-integration-aCV7X

# Create the ECR repo
aws ecr create-repository \
  --repository-name mike-backend \
  --region ap-southeast-2 \
  --image-scanning-configuration scanOnPush=true \
  --image-tag-mutability MUTABLE

# Authenticate docker to ECR
aws ecr get-login-password --region ap-southeast-2 \
  | docker login --username AWS --password-stdin 711472107944.dkr.ecr.ap-southeast-2.amazonaws.com

# Build + push
# Drop the --platform flag if EC2 is already x86_64 (most likely).
# Keep it if the EC2 is Graviton/ARM but we want x86 Fargate.
docker buildx build \
  --platform linux/amd64 \
  -t 711472107944.dkr.ecr.ap-southeast-2.amazonaws.com/mike-backend:v1 \
  -t 711472107944.dkr.ecr.ap-southeast-2.amazonaws.com/mike-backend:latest \
  --push \
  ./backend

# Confirm
aws ecr describe-images \
  --repository-name mike-backend \
  --region ap-southeast-2 \
  --query 'imageDetails[*].[imageTags,imagePushedAt,imageSizeInBytes]' \
  --output table
```

Expected image size: ~800 MB-1 GB (LibreOffice writer is the bulk).

## Things to keep in mind for future steps

- **SSE streaming:** ALB idle timeout default is 60s — bump to **240s** for the chat endpoint. HTTP/2 is fine.
- **Two ECS roles, not one:** the *task role* (`mike-ecs-task-role`, already created — what the container assumes) vs the *task execution role* (boilerplate, ECS itself uses to pull from ECR / write to CloudWatch). When creating the ECS service, accept the prompt to auto-create `ecsTaskExecutionRole`.
- **`FRONTEND_URL` env var:** the backend reads this on startup for CORS — must be set to the Amplify domain before starting the ECS task, or CORS will block.
- **Secrets:** plan to put these in Secrets Manager under prefix `mike/`:
  - `mike/supabase` — `SUPABASE_URL`, `SUPABASE_SECRET_KEY`
  - `mike/anthropic` — `ANTHROPIC_API_KEY`
  - `mike/gemini` — `GEMINI_API_KEY`
  - `mike/openrouter` — `OPENROUTER_API_KEY`
  - `mike/resend` — `RESEND_API_KEY`
  - The task role already has `secretsmanager:GetSecretValue` on `mike/*`.
- **Frontend Amplify:** app root is `frontend/`. Ignore `open-next.config.ts` and any Cloudflare-specific build scripts — Amplify just runs `next build`. Four env vars from `frontend/.env.local.example`.
- **Don't commit secrets.** `.env` and `.env.*` are gitignored on both backend and frontend; verified.
