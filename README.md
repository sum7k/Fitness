# Sized — Telegram fitness bot

A voice-first fitness companion that logs food and exercise with **rough calorie estimates**. Consistency over fake precision — just tell it what you ate.

V1 ships as a **Telegram bot**: hold-to-talk voice notes, photos, text logging, one-tap calorie corrections (±50/±100), and an AI buddy that answers from the user’s own data.

See `SPEC.md` and `ARCHITECTURE.md` for older product notes (sizes were the original design; the live bot now speaks calories).

## Setup

```bash
npm install
```

Create a `.env` (or symlink one) with:

```bash
TELEGRAM_BOT_TOKEN=...      # from @BotFather
OPENROUTER_API_KEY=...
BOT_ACCESS_CODE=...         # shared invite code; rotate anytime (exact match)

# Optional overrides
# MODEL_CHEAP=google/gemini-2.5-flash
# MODEL_BUDDY=deepseek/deepseek-chat
# MODEL_SIM_USER=google/gemini-2.5-flash
# DB_PATH=data/fitness.db
# DEFAULT_TZ=Asia/Kolkata
```

New users must send the access code before the bot will log or chat (no LLM calls until then). Changing `BOT_ACCESS_CODE` rotates the invite; already-whitelisted users stay in. Existing DB users are grandfathered on startup.

Voice notes need `ffmpeg` on your PATH.

## Run the bot

```bash
npm run dev
```

Long-polls Telegram. Talk to the bot in chat: `/start` for onboarding, then log meals/exercise by voice or text.

```bash
npm run typecheck
```

## Synthetic user simulator

Local harness that **invents a persona**, roleplays as that user, and converses with the real bot pipeline (no Telegram). Writes conversation transcripts you can mine for friction, bad replies, and missing features.

Uses a separate DB (`data/sim.db`) so sim runs never touch real user data.

```bash
# 3 runs cycling all scenarios
npm run sim -- --n 3

# Specific scenarios
npm run sim -- --n 10 --scenarios why_not_losing,messy_hinglish_log

# Parallel runs
npm run sim -- --n 20 --concurrency 2 --out data/transcripts
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--n` | `3` | Number of conversations |
| `--scenarios` | `all` | Comma-separated scenario ids, or `all` |
| `--out` | `data/transcripts` | Output directory |
| `--concurrency` | `1` | Parallel conversations |

Each run writes a `.jsonl` (machine-readable) and `.md` (skimmable) pair under `--out`.

### Scenarios

| Id | Stresses |
|----|----------|
| `first_day_onboarding` | Goal wizard, budget explanation, first logs |
| `messy_hinglish_log` | Extraction + Indian foods + Hinglish |
| `whole_day_backfill` | Multi-item whole-day narration |
| `calorie_disagreement` | Correction UX + personal overrides |
| `why_not_losing` | Buddy grounded in seeded history |
| `over_budget_shame` | Neutral over-budget copy |
| `medical_edge` | Safety deflection |
| `exercise_to_eat` | Exercise credit damping |
| `lapsed_streak` | Streak messaging after a gap |
| `budget_tinker` | `/budget` + floor warnings |

## Deploy on Dokploy

This is a **long-polling Telegram bot** (no public HTTP port). Use a **Dockerfile** build so `ffmpeg` and native `better-sqlite3` are available, and mount a volume for SQLite.

### 1. Push the repo

Commit `Dockerfile` / `.dockerignore` and push to GitHub/GitLab.

### 2. Create the app in Dokploy

1. Project → **Create Service** → **Application**
2. **Source**: your Git repo + branch
3. **Build Type**: **Dockerfile** (not Nixpacks) — Nixpacks defaults to Node 18, which cannot install `better-sqlite3@12`
4. Dockerfile path: `Dockerfile`

### 3. Environment variables

In the Environment tab:

```bash
TELEGRAM_BOT_TOKEN=...
OPENROUTER_API_KEY=...
DB_PATH=/app/data/fitness.db
DEFAULT_TZ=Asia/Kolkata
# optional:
# MODEL_CHEAP=google/gemini-2.5-flash
# MODEL_BUDDY=deepseek/deepseek-chat
```

### 4. Persistent volume (required)

SQLite must survive redeploys:

| Host / volume path | Container path |
|--------------------|----------------|
| e.g. `fitness-data` | `/app/data` |

In Dokploy: **Advanced** → **Volumes** → mount a named volume (or bind path) to `/app/data`.

### 5. Deploy

Click **Deploy**. Watch logs for `@yourbot up, long polling.`

No domain is needed for long polling. Domains are only required later if you switch the bot to **webhook** mode.

### Notes

- **Replicas = 1** — SQLite + long polling must not run as multiple instances.
- Back up `/app/data` (or the volume) regularly.
- Voice notes need `ffmpeg` (already in the Dockerfile).
- For production hardening later: webhook + HTTPS domain (ARCHITECTURE §8).
