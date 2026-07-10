# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A voice-first **Telegram fitness bot** ("Sized", name TBD). Users speak/type/photograph what they ate or did; a cheap multimodal LLM extracts structured entries and assigns **t-shirt sizes** (XS–XXXL) instead of calorie counts. The product bet: *adherence beats accuracy* — a rough log kept for a year beats a perfect log abandoned in three weeks. Read `SPEC.md` for product rationale and `ARCHITECTURE.md` for the V1 design; both are the source of truth and are referenced by section (e.g. "SPEC §3.1") throughout the code comments.

## Commands

```bash
npm run dev          # tsx watch src/main.ts — runs the bot, long polling
npm run typecheck    # tsc --noEmit (no build step; tsx runs TS directly)
npx tsx scripts/smoke.ts          # one live extraction call, prints the JSON (hits OpenRouter)
npx tsx scripts/onboard-check.ts  # deterministic guardrail test — NO LLM call; isolation + budget clamps
```

There is no test runner and no lint config. `scripts/onboard-check.ts` is the closest thing to a unit test — it exits non-zero on failure and asserts cross-user data isolation and safety clamps. Run it after touching `onboard.ts`, `energy.ts`, or anything that assembles per-user context. Requires Node 22+, `ffmpeg` on PATH (voice transcode), and env vars `TELEGRAM_BOT_TOKEN` + `OPENROUTER_API_KEY` (loaded from `.env`, a symlink; `scripts/smoke.ts` needs the key, `onboard-check.ts` does not).

Note: source imports use `.js` extensions on `.ts` files (NodeNext ESM). Keep that convention — `import { x } from "./foo.js"` resolves `foo.ts`.

## Architecture

**One process:** grammY bot + `better-sqlite3` (WAL mode) + in-memory OpenRouter calls. No separate ASR, no queue, no external DB. Entry point `src/main.ts` → `createBot()` in `src/bot/bot.ts`.

**The ingest pipeline** (`src/bot/ingest.ts`) is the spine — voice, photo, and text all converge on it:
1. Input → `InputPart[]` (voice: download OGG → `ffmpeg` transcode to 16kHz mono mp3 → base64; photo: base64 data URL; text: as-is).
2. `extract()` (`src/llm/extract.ts`) — **single** cheap-model call returns `{transcript, intent, entries[], weight_kg, chat_text}` as strict JSON-schema output. Transcription + intent routing + entry extraction + size guessing all happen in this one call.
3. `applySizing()` (`src/domain/sizing.ts`) — **sizing waterfall**: personal `overrides` → global `size_cache` → trust the LLM's own guess (and cache it, but only unambiguous unquantified names). Bundled food/exercise DBs are a planned insert between cache and LLM (not built yet).
4. Insert entries, reply one message per entry with an inline size-correction keyboard, then a tally bar.
5. If `intent` is `chat`/`mixed`, a second **strong-model** call (`buddyReply`, `src/llm/buddy.ts`) answers with the user's own data as context.

**Two-model split** (`src/config.ts`): `modelCheap` (default `google/gemini-2.5-flash`) handles all extraction AND onboarding because it ingests voice-note **audio** natively — no other tiered model on OpenRouter reliably does. `modelBuddy` (default `deepseek/deepseek-chat`) is text-only, ~10× cheaper than Sonnet, used only for buddy chat. Both go through the single `chat()` wrapper in `src/llm/openrouter.ts`, which speaks the OpenRouter chat-completions API and supports `response_format: json_schema`.

**LLM proposes, code decides.** This is the load-bearing safety pattern. The onboarding model (`src/llm/onboard.ts`) gathers facts and proposes a *discrete pace bucket* ("gentle"…"aggressive"), never a number. All arithmetic and clamping lives in `src/domain/energy.ts`: Mifflin-St Jeor BMR → TDEE → budget, with `clampRateKgWk` (≤1% bodyweight/week) and `safeFloorKcal` (1500 male / 1200 female) enforced in code so a chatty model can never set an unsafe budget. Never move budget math into a prompt. `applyUpdates` in `src/bot/onboarding.ts` range-checks every field the model returns before persisting.

**Sizes are the domain currency** (`src/domain/sizes.ts`): kcal is stored internally but bucketed to sizes at display time; users never see numbers. 1 budget unit = M = ~200 kcal. Food rounds **up** on a bucket boundary, exercise rounds **down** (conservative both ways). Exercise credit is damped to 50% (`EXERCISE_CREDIT`) — "exercise to eat" is a loop the product refuses to reinforce. Tally math and streak logic are in `src/domain/tally.ts`; streaks count *days with any log*, not days on budget.

**Data model** (`src/db/index.ts`): schema is created inline on startup via `CREATE TABLE IF NOT EXISTS`, plus a hand-rolled additive migration block (checks `PRAGMA table_info`, `ALTER TABLE ADD COLUMN` for missing cols). There is no migration framework — add columns to both the `CREATE` block and the `adds` array. All "today" logic keys off `day_local` (computed from the user's `tz`, default Asia/Kolkata). `chat_log` is a short rolling window, trimmed to the last 20 rows per user.

**Onboarding is stateful conversation, not a wizard.** `users.onboarding_state = 'chat'` routes text/voice into `handleOnboarding` instead of `ingest` (see the branches in `bot.ts`). The model tracks stage (`gathering`→`proposing`→`confirmed`); code commits the budget only on a real `proposing`→`confirmed` transition with a live `pending_rate`.

## Conventions & gotchas

- **Per-user scoping is a security boundary.** Every DB read/write is scoped by `user_id`. `buildOnboardMessages` is deliberately pure and takes only one user's profile + history — the isolation test in `onboard-check.ts` guards against ever leaking another user's data into a prompt. Preserve this when adding context assembly.
- Callback data is compact: `e:<entryId>:s:<SIZE>` and `e:<entryId>:del`, parsed by regex in `bot.ts`. A size correction also upserts a personal `override` so the item is remembered next time.
- LLM JSON is parsed with `parseJsonLenient` (strips markdown fences some models add despite `response_format`). Onboarding retries once on malformed JSON.
- Logging: `src/log.ts` — `debug`/`info`/`error`, level via `LOG_LEVEL` (default `debug`). The ingest path logs transcript + extraction + sizing decisions; keep new debug lines terse and single-line.
- `data/` (the SQLite files) and `.env` are gitignored. This directory is **not** a git repo yet.
