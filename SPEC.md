# Product Spec — Working title: "Sized" (name TBD)

A voice-first fitness companion that trades false precision for effortless consistency.

---

## 1. Thesis

People fail at fitness tracking because logging is tedious and precision is fake. Calorie labels are ±20%, exercise burn estimates are worse, yet every app demands exact numbers typed into forms. Users burn out in weeks.

We invert both assumptions:

1. **Input is speech.** Press one button, say what you ate or did. The app estimates and records. Under 3 seconds from urge to done.
2. **Measurement is fuzzy on purpose.** No calorie counts. Food and exercise get t-shirt sizes (XS–XXXL), like story points in software estimation. The rounding is the feature: it is honest about error bars and removes the anxiety of exact numbers.

Everything in the product serves one principle: **adherence beats accuracy.** A rough log kept for a year outperforms a perfect log abandoned in three weeks.

### Platform decision: Telegram bot

V1 ships as a **Telegram bot**, not a native app. Telegram natively provides everything the capture and buddy pillars need — hold-to-talk voice notes, photo messages, a chat surface for the buddy, inline keyboards for one-tap corrections, and bot-initiated messages for free push notifications — with zero app-store friction and a prototype-in-days build cost. LLM provider is **OpenRouter** (single API, lets us tier models freely).

Known platform losses, accepted for V1: no passive step reading (Health Connect has no cloud API) and no home-screen widget. Both return via a thin companion Android app in V2 whose only job is syncing Health Connect data to our backend. A Telegram Mini App (embedded web view) is the upgrade path for richer dashboards without leaving Telegram.

---

## 2. Target user

- Has tried MyFitnessPal / calorie counters and quit because of logging fatigue.
- Wants to lose, maintain, or gain weight; not a bodybuilder needing macro precision.
- Comfortable talking to their phone.
- Age 20–45, smartphone-native.

**Anti-user (not for v1):** competitive athletes, medical/clinical nutrition needs, users who want gram-level macro tracking.

---

## 3. Core concepts

### 3.1 The size scale

One scale for both food (energy in) and exercise (energy out). Buckets widen as values grow, Fibonacci-style, because uncertainty grows too:

| Size | Approx. kcal midpoint | Food example | Exercise example |
|------|----------------------|--------------|------------------|
| XS   | ~50   | An apple, black coffee with sugar | 10-min stroll |
| S    | ~100  | A banana, a slice of bread | 15-min brisk walk |
| M    | ~200  | Bowl of dal + rice, small sandwich | 20-min jog |
| L    | ~400  | Restaurant burger, biryani plate | 45-min gym session |
| XL   | ~600  | Pizza (half), thali with dessert | 10k run |
| XXL  | ~800  | Large fast-food meal | Long trail hike |
| XXXL | ~1200+ | Buffet visit, festival meal | Half marathon |

Rules:
- Users never see kcal numbers anywhere in the default UI. Sizes only.
- Internally everything is stored as kcal estimates and bucketed at display time (so buckets can be tuned later without data loss).
- When the estimator is torn between two sizes, it rounds **up** for food and **down** for exercise (conservative default; keeps users honest).

### 3.2 Daily budget ("the wardrobe")

Goal setup produces a daily food budget expressed in sizes, e.g. **"about 10 M per day"** (internally ~2000 kcal). Exercise earns sizes back. The home screen answers one question at a glance: *how much room is left today?*

- Display as a simple visual tally (filled/empty size tokens), not a number gauge.
- Exercise credits are intentionally damped (earn back ~50% of estimated burn) because burn estimates skew high and "exercise to eat" is a bad loop to reinforce.
- Day ends in one of three states: **under / on / over**. No decimal shame. Over-budget copy is neutral, never punishing.

### 3.3 Protein dots (v1.5)

Second dimension on food, same fuzzy philosophy: `•` (low), `••` (moderate), `•••` (high protein). Daily protein target expressed as dot count. No grams shown.

---

## 4. The four pillars

1. **Capture** — voice first, photo later, passive data always. Speed is sacred.
2. **Measure** — t-shirt sizes + protein dots. Fuzzy on purpose.
3. **Loop** — daily budget, weight trend, streaks with forgiveness, weekly review.
4. **Buddy** — an AI companion that wraps the other three in a relationship.

---

## 5. Features

### 5.1 Capture

**F1. Voice logging (V1).** User sends a Telegram voice note (hold-to-talk). Bot transcribes, classifies each mentioned item as food/exercise/weight, estimates size, records. Multi-item utterances supported: "had poha and chai this morning, then walked to work" → 3 entries.

**F2. Whole-day narration (V1).** "Backfill mode" is just a longer utterance: user narrates the whole day, app splits it into timestamped entries (morning/lunch/evening inferred from words). This rescues lapsed loggers — critical for retention.

**F3. Text fallback (V1).** Same pipeline, typed. For meetings, libraries, noisy places.

**F4. Instant correction (V1).** Every recorded entry is replied to with the guessed size and an inline keyboard: size chips (XS…XXXL) plus delete. Corrections are remembered per-user per-item: "his biryani = L" wins over the global estimate next time.

**F5. Capture ergonomics (V1).** User pins the bot chat in Telegram; time-to-log = open pinned chat → hold mic → speak (~5 s). A native widget/shortcut is deferred to the companion app (V2).

**F6. Steps by voice (V1).** No passive step reading on Telegram (Health Connect is on-device only). Interim: user speaks steps ("walked 8k steps today") and the bot converts to earned sizes. Passive sync returns via the companion app (F9).

**F7. Photo input (V1).** Send a meal photo, vision model estimates size + protein dots. Same correction reply. (Promoted from V1.5 — on Telegram this is the same multimodal pipeline as voice, marginal cost near zero.)

**F8. Barcode scan (V2).** Packaged foods via Open Food Facts — user photographs the barcode.

**F9. Companion Android app (V2).** Thin app, one job: sync Health Connect steps/sleep to the backend, plus a home-screen mic widget. Not a second UI.

**F10. Passive sleep (V2).** Via the companion app, shown in weekly review only.

### 5.2 Measure (estimation pipeline)

**F11. Local food DB (V1).** Bundled, curated subset (~2–5k common items) built from USDA FoodData Central + Open Food Facts; add IFCT 2017 items if launching with Indian users. Pre-bucketed sizes. Instant, offline, free.

**F12. Local exercise DB (V1).** Compendium of Physical Activities MET table. `kcal = MET × weight_kg × hours`, bucketed to size using the user's logged weight.

**F13. LLM fallback estimator (V1).** Anything the DB misses goes to a cheap model via OpenRouter asked one easy question: *which size bucket?* Fuzzy buckets make this safe — guessing "M vs L" is far more reliable than guessing 347 kcal. Responses cached globally.

**F14. Personal overrides (V1).** User corrections (F4) form a per-user dictionary consulted before DB and LLM.

**F15. Protein dots on foods (V1.5).** Added to DB entries and to the LLM fallback prompt.

### 5.3 Loop

**F16. Goal wizard (V1).** 60-second onboarding: current weight → goal (lose/maintain/gain) → pace (gentle/standard) → daily budget in sizes. Hard floor on aggressiveness (see §7 guardrails).

**F17. Daily tally (V1).** Home screen: size tokens remaining today, today's entries as a scrollable card list.

**F18. Weight tracking (V1).** Logged by voice ("weighed 82 today") or tap. Chart shows a **7-day rolling average trend line** as the hero; daily points are faint dots. Copy always references the trend, never a single weigh-in.

**F19. Streaks with forgiveness (V1).** Streak counts *days with any log*, not days on budget. One automatic "repair token" per week: a single missed day does not reset the streak. Streak-reset guilt is the #1 churn trigger in this category — forgiveness is a core mechanic, not a nicety.

**F20. Weekly review (V1.5).** Sunday recap delivered by the Buddy as a conversation, not a stats page: average day size, weight trend delta, logging consistency, one specific observation (e.g. "weekends run XL"), one suggested intent for next week.

**F21. Smart nudge (V1.5).** At most one per day. Fires only if nothing is logged by a learned typical-lunch time. Worded by the Buddy in its voice ("no lunch logged — all good?"). Never guilt-based. Easy to mute.

### 5.4 Buddy

**F22. Conversational buddy (V1 — reactive only).** Same mic/text input; an intent router sends utterances to *log* or *chat*. No mode switch. The buddy answers with full user context: current budget, streak, weight trend, last 30 days of entries, correction history. Signature ability: answers "why am I not losing weight?" with the user's own data.

**F23. Size explanations (V1).** "Why was that L?" — buddy explains the estimate and accepts spoken corrections ("it was a small portion" → downgrades to M, remembers).

**F24. Buddy memory (V1.5).** Summarized durable facts ("vegetarian, hates cardio, travels Mondays"), not raw chat history. Injected into every conversation.

**F25. Proactive buddy (V1.5).** Owns the smart nudge (F21) and weekly review (F20).

**F26. Personality slider (V2).** Gentle friend ↔ drill sergeant. Same facts, different voice.

---

## 6. MVP cutline

### V1 — the MVP (ship this)

The smallest product that proves the thesis: *voice in → size out → daily loop → user comes back.*

- Voice logging + whole-day narration + text fallback (F1, F2, F3)
- Photo input (F7) — near-free on Telegram, same multimodal pipeline
- Correction replies + personal overrides (F4, F14)
- Steps by voice (F6)
- Local food + exercise DBs, LLM fallback via OpenRouter (F11, F12, F13)
- Goal wizard, daily tally, weight trend chart (F16, F17, F18)
- Streaks with forgiveness (F19)
- Reactive buddy + size explanations (F22, F23)
- Safety guardrails (§7) — these are V1, not later

**Explicitly OUT of V1:** protein dots, weekly review, nudges, buddy memory/personality, barcode, companion app / passive data, sleep, any social features, Telegram Mini App dashboard.

### V1.5 — the retention release (4–8 weeks after V1)

- Protein dots (F15, §3.3)
- Weekly review via buddy (F20)
- Smart nudge (F21)
- Buddy memory + proactive buddy (F24, F25)

### V2 — expansion

- Companion Android app: passive steps/sleep sync + mic widget (F9, F10)
- Barcode scan (F8)
- Personality slider (F26)
- Telegram Mini App dashboard (rich charts, history browsing)
- Accountability/social (buddy-mediated check-ins with a friend) — only if V1.5 retention supports it

---

## 7. Safety guardrails (V1, non-negotiable)

- **No medical advice.** Buddy deflects diagnosis, medication, supplement dosing, and injury questions to professionals.
- **Eating-disorder red flags.** Extreme deficit requests, punishment framing after eating, compulsive body-checking patterns → buddy responds with care, never optimizes the restriction, surfaces help resources when a pattern persists.
- **Goal floor.** The goal wizard refuses budgets below a safe threshold (BMR-anchored) and paces faster than ~1% body weight/week.
- **Exercise credit damping** (§3.2) to avoid reinforcing "exercise to earn food."
- **Neutral over-budget copy.** "Over" days are stated, never shamed.

---

## 8. Success metrics

| Metric | Target | Why |
|--------|--------|-----|
| Time-to-log (button press → entry saved) | < 3 s median | The core promise |
| Logging days per week, week 4 | ≥ 4 | Adherence is the product |
| D30 retention | > 20% (2× category norm) | Thesis validation |
| Correction rate on estimates | 10–25% | Too low = nobody checks; too high = estimator broken |
| Weekly weigh-ins per active user | ≥ 1 | Loop is closed |
| Buddy conversations per WAU | ≥ 2/week | Relationship forming |

---

## 9. Cost architecture

- **Single provider: OpenRouter.** One API key, free model tiering.
- **Tier routing:** cheap multimodal model (e.g. Gemini Flash class) for voice-note transcription + intent routing + entry extraction + size estimation in one call (high volume, easy task); strong model only for buddy conversations and weekly reviews (low volume, quality-sensitive).
- **Audio path:** Telegram voice notes arrive as OGG/Opus; transcode with ffmpeg to a format the multimodal model accepts, send audio directly — no separate ASR service unless quality forces it.
- **Caching:** global cache of (food string → size) LLM answers; personal overrides short-circuit everything.
- Free tier: unlimited logging, capped buddy conversations. Paid: unlimited buddy, weekly review. (Logging must never be paywalled — it feeds the moat.)

---

## 10. Decisions & open questions

**Decided:**
- Platform: Telegram bot (V1); thin companion Android app in V2 for Health Connect + widget.
- LLM provider: OpenRouter.
- Primary user device: Android.

**Open:**
1. **Region/market:** determines food DB curation (IFCT for India) and language support. Hindi/Hinglish utterances ("do roti aur dal khaya") are a real requirement if India — multimodal models handle Hinglish audio well, but DB curation must follow.
2. **Name and brand** (also becomes the bot username).
3. **Monetization timing:** paywall at V1.5 or later?
4. **Exact model picks on OpenRouter** for cheap tier vs buddy tier — verify voice-note audio input works through OpenRouter for the chosen cheap model before committing (test first, it's one curl).

---

## 11. Non-goals

- Gram-level macro tracking, meal planning, recipes (v-never until proven demand)
- Workout programming / training plans (buddy may discuss, app does not prescribe)
- Wearable heart-rate integrations beyond steps/sleep
- Social feeds, leaderboards, public profiles
