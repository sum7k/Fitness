# Architecture — Telegram Fitness Bot (V1)

Companion to `SPEC.md`. Covers the V1 cutline only.

---

## 1. Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | Node.js 22 + TypeScript | One language now and for the future Telegram Mini App (web) |
| Bot framework | grammY | Best-maintained TS Telegram framework; long polling for dev, webhook for prod; built-in inline-keyboard and conversation helpers |
| Database | SQLite (better-sqlite3) | Single-file, zero ops, plenty for MVP scale; migrate to Postgres only when concurrent users demand it |
| LLM | OpenRouter (single API key) | Free model tiering across vendors |
| Audio | ffmpeg (transcode OGG/Opus → MP3/WAV) | Telegram voice notes are OGG; multimodal models want MP3/WAV |
| Charts | chartjs-node-canvas → PNG sent as Telegram photo | Weight trend chart, weekly visuals |
| Scheduler | node-cron in-process | Daily rollups; nudges/reviews later (V1.5) |
| Deploy | Single small VPS or Fly.io/Railway, one process | Bot + SQLite + cron in one box |

Secrets via environment: `TELEGRAM_BOT_TOKEN`, `OPENROUTER_API_KEY`.

---

## 2. Model tiers (OpenRouter)

| Tier | Used for | Candidate | Volume |
|------|----------|-----------|--------|
| Cheap multimodal | Voice-note understanding (audio in), photo sizing, text entry extraction, intent routing | Gemini Flash class | High — every log |
| Strong | Buddy conversations, size explanations | Claude Sonnet class | Low — chats only |

**One-call extraction:** the cheap model receives the raw audio (or photo, or text) plus a system prompt and returns structured JSON — transcription, intent, and extracted entries in a single call. No separate ASR service.

**Verify before building:** audio input for the chosen cheap model *through OpenRouter* (input format, base64 size limits). One curl test. If audio-through-OpenRouter proves unreliable, fallback plan is a dedicated ASR step (e.g. a hosted Whisper) feeding the same extraction prompt as text — pipeline shape is unchanged.

### Extraction schema (cheap model output)

```json
{
  "transcript": "had poha and chai, then walked to work",
  "intent": "log | chat | weight | mixed",
  "entries": [
    {
      "kind": "food | exercise",
      "name": "poha",
      "quantity_hint": "1 bowl",
      "kcal_estimate": 250,
      "size": "M",
      "confidence": "high | low",
      "meal_slot": "breakfast | lunch | dinner | snack | unknown"
    }
  ],
  "weight_kg": null,
  "chat_text": null
}
```

- `intent: mixed` allowed — "logged breakfast, also why is my weight stuck?" produces entries *and* `chat_text`; bot records first, then answers.
- `kcal_estimate` stored internally; `size` is what the user sees (buckets per SPEC §3.1).
- Low-confidence entries get a 🤔 marker in the reply, inviting correction.

---

## 3. Message flow

### 3.1 Ingest (voice / photo / text — same pipeline)

```
Telegram update
  → grammY handler
  → if voice: download file, ffmpeg transcode
  → personal override lookup (exact-ish name match) ── hit: size known, skip LLM sizing
  → cheap model call (audio|image|text → extraction JSON)
  → global size-cache lookup per entry (normalized name → size); miss: trust LLM, insert into cache
  → insert entries (SQLite)
  → reply: one message per entry batch
      "🍛 poha — M    🍵 chai — S    🚶 walk — XS earned
       Today: ▓▓▓▓▓░░░░░  5 M left"
      [inline keyboard per entry: XS S M L XL ✕]
  → if intent chat/mixed: strong-model call with user context → buddy reply
```

### 3.2 Correction (inline button callback)

```
callback_query "entry:123:size:L"
  → update entry size + kcal midpoint
  → upsert personal override (user_id, normalized_name → size)
  → edit original message in place (new size, updated tally)
```

### 3.3 Buddy context assembly (strong model)

System prompt = persona + guardrails (SPEC §7).
Context block, assembled per conversation, token-capped:
- goal, daily budget, today's tally
- weight trend: last 8 weekly rolling averages
- last 30 days: entries summarized per day (total size units, on/over/under)
- streak state
- last few chat turns (short window; durable memory is V1.5)

### 3.4 Onboarding (goal wizard)

`/start` → grammY conversation: current weight → goal (lose/maintain/gain) → pace (gentle/standard) → computes daily budget in size units (BMR-anchored, safety floor per SPEC §7) → pins a "how to log" message with examples.

---

## 4. Data model (SQLite)

```sql
users        (id, tg_user_id, created_at, weight_kg, goal, pace,
              daily_budget_units, tz, streak_current, streak_repair_available)
entries      (id, user_id, kind, name, name_normalized, size, kcal_estimate,
              meal_slot, logged_at, day_local, source,        -- voice|photo|text
              confidence)
weights      (id, user_id, weight_kg, measured_at, day_local)
overrides    (user_id, name_normalized, size, kcal_estimate, updated_at)
size_cache   (name_normalized, size, kcal_estimate, protein_dots, model, created_at)
food_db      (name, aliases, kcal_per_serving, size, protein_dots, source)  -- bundled, read-only
exercise_db  (name, aliases, met_value, source)                              -- Compendium, read-only
chat_log     (id, user_id, role, text, created_at)   -- short window only, pruned
```

- All "today" logic uses `day_local` computed from user timezone (ask region during onboarding or read from Telegram language hint; default Asia/Kolkata until set).
- Budget math in **size units** where 1 unit = M = ~200 kcal midpoint; XS=0.25, S=0.5, M=1, L=2, XL=3, XXL=4, XXXL=6.

---

## 5. Domain logic

**Sizing:** DB hit → use DB size. Miss → override → cache → LLM. Exercise: `kcal = MET × weight_kg × hours` from the Compendium table, then bucket; damp earned credit to 50% (SPEC §3.2). Tie-break rounds up for food, down for exercise.

**Streaks:** a day counts if it has ≥1 entry. Nightly cron (per-user local midnight): if yesterday empty and repair token available → consume token, streak survives, note it in next reply ("streak repaired 🔧"); else reset. Token refills weekly.

**Weight trend:** store raw weigh-ins; chart 7-day rolling average as the hero line, raw points faint. Rendered on demand for `/trend` and after each weigh-in (throttled to once/day).

**Commands** (thin — voice is the primary interface):
- `/start` onboarding · `/today` tally + entries · `/trend` weight chart · `/streak` · `/undo` delete last entry · `/help` examples

---

## 6. Safety guardrails (implementation)

- Buddy system prompt: no medical advice, no supplement dosing, ED-aware response patterns (SPEC §7), with a lightweight classifier check on user chat messages that flags red-flag patterns for the softer response path.
- Goal wizard: reject budgets below BMR-anchored floor; cap pace at ~1% body weight/week; copy explains why.
- Over-budget day copy: neutral, factual, never shaming — templated, not LLM-improvised.

---

## 7. Costs (order of magnitude, per active user per month)

- ~120 logs × 1 cheap multimodal call (~10s audio + small JSON out) → cents.
- ~10 buddy chats × strong model with ~2k-token context → tens of cents.
- Total well under $1/user/month at V1 usage. Cache hit rate improves this over time.

---

## 8. Build order

1. Skeleton: grammY bot, long polling, `/start` stub, SQLite migrations.
2. Text logging end-to-end (extraction call → entries → reply + tally + inline correction). Text first — proves the pipeline without ffmpeg.
3. Voice path (download, transcode, audio-in extraction). **Do the OpenRouter audio curl test before this step.**
4. Photo path (same call, image input).
5. Food/exercise DB import scripts + sizing waterfall (override → cache → DB → LLM).
6. Goal wizard + budget + streaks + weight trend chart.
7. Buddy: intent routing to strong model with context assembly + guardrail prompt.
8. Deploy: webhook mode, VPS, backups of SQLite file.

Each step is independently demoable in Telegram.

---

## 9. Risks

| Risk | Mitigation |
|------|------------|
| Audio input via OpenRouter flaky/unsupported for chosen model | Curl test up front (step 3 gate); fallback: hosted Whisper ASR → same text pipeline |
| Size estimates feel wrong → trust loss | Correction UX is one tap; overrides learn fast; conservative rounding |
| Telegram as a dependency (policy/reach) | Core logic is platform-agnostic behind the ingest layer; Mini App and companion app widen the surface later |
| Hinglish/vernacular utterances | Multimodal models handle Hinglish audio well; add IFCT food DB for Indian dishes; test with real utterances early |
| SQLite write contention if usage spikes | WAL mode; migration path to Postgres is mechanical |
