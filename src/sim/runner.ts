import { BotSession, type BotTurn } from "../core/session.js";
import { inventPersona, type Persona } from "./persona.js";
import { nextSimAction, type TranscriptTurn, type SimAction } from "./simuser.js";
import { writeTranscript, newRunId, defaultModels, type TranscriptMeta } from "./transcript.js";
import type { Scenario } from "./scenarios.js";
import { dayLocal, db, normalizeName } from "../db/index.js";

const ONBOARDING_TURN_CAP = 16;

export interface RunResult {
  run_id: string;
  scenario: string;
  jsonl: string;
  md: string;
  turns: number;
  done_reason?: string;
  error?: string;
}

async function applyAction(session: BotSession, action: SimAction): Promise<BotTurn[]> {
  switch (action.action) {
    case "text":
      return session.sendText(action.text);
    case "correct":
      return session.setKcal(action.entry_id, action.kcal);
    case "delete":
      return session.deleteEntry(action.entry_id);
    case "command":
      return session.command(action.command, action.arg ?? "");
    case "done":
      return [];
  }
}

function userTextFor(action: SimAction): string {
  switch (action.action) {
    case "text": return action.text;
    case "correct": return `[correct entry#${action.entry_id} → ~${action.kcal} kcal]`;
    case "delete": return `[delete entry#${action.entry_id}]`;
    case "command": return `/${action.command}${action.arg ? " " + action.arg : ""}`;
    case "done": return `[done: ${action.reason}]`;
  }
}

/** Seed days with a gap at the end (for lapsed_streak). */
function seedWithGap(session: BotSession, persona: Persona, scenario: Scenario): void {
  if (!scenario.seed) return;

  if (scenario.id === "lapsed_streak") {
    const user = db
      .prepare("SELECT * FROM users WHERE tg_user_id = ?")
      .get(session.tgUserId) as { id: number; tz: string };
    const foods = scenario.seed.foodsPerDay ?? [{ name: "idli", kcal: 200 }];
    const insert = db.prepare(
      `INSERT INTO entries (user_id, kind, name, name_normalized, kcal_estimate,
                            meal_slot, confidence, source, day_local, logged_at)
       VALUES (?, ?, ?, ?, ?, 'unknown', 'high', 'text', ?, ?)`,
    );
    for (let d = 7; d >= 4; d--) {
      const date = new Date(Date.now() - d * 24 * 3600 * 1000);
      const day = dayLocal(user.tz, date);
      const iso = date.toISOString().replace("T", " ").slice(0, 19);
      for (const f of foods) {
        insert.run(
          user.id, f.kind ?? "food", f.name, normalizeName(f.name), f.kcal,
          day, iso,
        );
      }
    }
    return;
  }

  session.seedHistory({
    days: scenario.seed.days,
    weight_kg: persona.weight_kg,
    weightDeltaPerDay: scenario.seed.weightDeltaPerDay,
    foodsPerDay: scenario.seed.foodsPerDay,
  });
}



export async function runOne(
  scenario: Scenario,
  outDir: string,
  log: (msg: string) => void = console.log,
): Promise<RunResult> {
  const run_id = newRunId();
  const history: TranscriptTurn[] = [];
  let turnI = 0;
  let done_reason: string | undefined;
  let error: string | undefined;

  const meta: TranscriptMeta = {
    run_id,
    scenario: scenario.id,
    stress: scenario.stress,
    persona: null as unknown as Persona,
    models: defaultModels(),
    started_at: new Date().toISOString(),
  };

  try {
    log(`[${scenario.id}/${run_id}] inventing persona…`);
    const persona = await inventPersona(scenario);
    meta.persona = persona;
    log(`[${scenario.id}] persona: ${persona.name}, ${persona.goal}, ${persona.language_mix}`);

    const session = new BotSession();
    history.push({ i: turnI++, from: "bot", turns: session.start() });

    let seeded = false;
    let postOnboardUserTurns = 0;
    let onboardUserTurns = 0;

    while (true) {
      const snapshot = session.snapshot();

      if (!snapshot.onboarding && !seeded) {
        seedWithGap(session, persona, scenario);
        seeded = true;
        log(`[${scenario.id}] onboarding done — history seeded=${!!scenario.seed}`);
      }

      const inOnboarding = snapshot.onboarding;
      const turnIndex = inOnboarding ? onboardUserTurns : postOnboardUserTurns;
      const maxTurns = inOnboarding ? ONBOARDING_TURN_CAP : scenario.maxTurns;

      if (!inOnboarding && postOnboardUserTurns >= scenario.maxTurns) {
        done_reason = `hit maxTurns (${scenario.maxTurns})`;
        break;
      }
      if (inOnboarding && onboardUserTurns >= ONBOARDING_TURN_CAP) {
        done_reason = "onboarding turn cap — stuck?";
        break;
      }

      const action = await nextSimAction({
        persona,
        scenario,
        history,
        snapshot: session.snapshot(),
        turnIndex,
        maxTurns,
      });

      history.push({
        i: turnI++,
        from: "user",
        action: action.action,
        text: userTextFor(action),
        payload: action,
      });
      if (inOnboarding) onboardUserTurns++;
      else postOnboardUserTurns++;

      if (action.action === "done") {
        done_reason = action.reason;
        log(`[${scenario.id}] done: ${done_reason}`);
        break;
      }

      log(`[${scenario.id}] user: ${userTextFor(action).slice(0, 80)}`);
      const botTurns = await applyAction(session, action);
      history.push({ i: turnI++, from: "bot", turns: botTurns });
      for (const t of botTurns) {
        log(`[${scenario.id}] bot(${t.kind}): ${t.text.slice(0, 100)}${t.text.length > 100 ? "…" : ""}`);
      }
    }

    if (!done_reason) done_reason = "loop ended";
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    log(`[${scenario.id}] ERROR: ${error}`);
  }

  meta.finished_at = new Date().toISOString();
  meta.done_reason = done_reason;
  meta.error = error;
  if (!meta.persona) {
    meta.persona = {
      name: "unknown", age: 0, locale: "", language_mix: "english", goal: "maintain",
      weight_kg: 0, height_cm: 0, sex: "female", activity: "sedentary", exercise_goal_days: 0,
      diet: "", personality: "", quirks: [], speaking_style: "",
    };
  }

  const paths = writeTranscript(outDir, meta, history);
  return {
    run_id,
    scenario: scenario.id,
    jsonl: paths.jsonl,
    md: paths.md,
    turns: history.length,
    done_reason,
    error,
  };
}

export async function runMany(opts: {
  scenarios: Scenario[];
  n: number;
  outDir: string;
  concurrency: number;
}): Promise<RunResult[]> {
  const queue: Scenario[] = [];
  for (let i = 0; i < opts.n; i++) {
    queue.push(opts.scenarios[i % opts.scenarios.length]);
  }

  const results: RunResult[] = new Array(queue.length);
  let cursor = 0;

  async function worker() {
    while (cursor < queue.length) {
      const idx = cursor++;
      results[idx] = await runOne(queue[idx], opts.outDir);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency, queue.length) }, () => worker()),
  );
  return results;
}
