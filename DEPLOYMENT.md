# Deployment

Anima Research Commons is deployed on Railway. This document is the single
source of truth — older deploy notes are preserved under `docs/archive/`.

## Prerequisites

- A Railway account
- A GitHub repository connected to Railway
- A JWT secret. Generate one with:
  ```bash
  openssl rand -hex 64
  ```

## First-time setup

### 1. Create the Railway project

1. railway.app → **New Project** → **Deploy from GitHub repo**.
2. Select the `research-commons` repo.
3. Railway will detect Node (Nixpacks) and start the first build.

### 2. Environment variables

In **Variables**, set at minimum:

| Variable     | Value                              |
| ------------ | ---------------------------------- |
| `JWT_SECRET` | output of `openssl rand -hex 64`   |
| `NODE_ENV`   | `production`                       |

The server now refuses to start if `JWT_SECRET` is unset or still the
placeholder value, so this step is mandatory.

Optional variables (defaults shown):

| Variable             | Default                       |
| -------------------- | ----------------------------- |
| `PORT`               | `3020`                        |
| `DATABASE_PATH`      | `/app/data/research.db`       |
| `SUBMISSIONS_PATH`   | `/app/data/submissions`       |
| `DATA_PATH`          | `/app/data`                   |
| `DISCORD_API_URL`    | unset (disables Discord import) |
| `DISCORD_API_TOKEN`  | unset                         |
| `RESEND_API_KEY`     | unset (disables password reset email) |
| `FROM_EMAIL`         | `noreply@resend.dev`          |
| `APP_URL`            | `http://localhost:5173`       |

See `.env.example` for a local-development template.

### 3. Persistent volume

**Without this, data is wiped on every deploy.**

Settings → Volumes → **+ New Volume**:

- Mount Path: `/app/data`
- Size: 1 GB to start

### 4. Health check

Railway picks up the `/health` endpoint automatically via `railway.toml`.

## Build

Railway runs (from `railway.toml`):

```
build:  nixpacks
start:  npm start
```

`npm start` runs `node dist/index.js`, which serves both the API and the
prebuilt frontend (`frontend/dist/`).

Nixpacks runs `npm run build:full` (backend + frontend) automatically.

## Post-deploy: create the first admin

The app auto-seeds default ontologies, rankings, models, and a research topic
on first boot. To create an admin user:

```bash
railway run npm run admin:create
```

This prompts for email/password/name and assigns the `admin` and `researcher`
roles in the JSONL user store.

To promote an existing user instead:

```bash
railway run npm run admin:promote -- user@example.com
```

(Replaces the old `make-admin.sh`, which silently did nothing because it
targeted a SQLite `user_roles` table that does not exist.)

## Verifying

1. Visit the Railway URL.
2. `GET /health` should return `{"status":"ok"}`.
3. Register an account, then promote it via `npm run admin:promote`.
4. `/models`, `/ontologies`, `/rankings`, `/topics` should each show the
   seeded defaults.
5. Submit a test conversation, annotate it, and confirm it persists after a
   Railway redeploy (the volume is doing its job).

## Troubleshooting

| Symptom                              | Likely cause                                          |
| ------------------------------------ | ----------------------------------------------------- |
| Boot fails with `JWT_SECRET is not set` | Missing or placeholder secret — see step 2.        |
| Data resets on every deploy          | Volume not mounted at `/app/data`.                    |
| Discord import disabled at boot      | `DISCORD_API_URL` / `DISCORD_API_TOKEN` unset.        |
| Password reset emails silent         | `RESEND_API_KEY` unset.                                |

## Cost (rough)

Railway Hobby plan ($5/month base) plus compute (cheap for this workload) plus
volume ($0.25/GB/month). Expect roughly $10/month for a low-traffic instance.
