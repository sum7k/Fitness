import { db, dayLocal, type Entry, type User } from "../db/index.js";
import { saveOverride } from "../domain/kcal.js";
import {
  computeTally, tallyLine, formatKcal, currentStreak, todayEntries, entryKcal,
} from "../domain/tally.js";
import {
  baseEnergy, safeFloorKcal, parseBudgetArg, unitsToKcal, hasEnergyProfile,
  type Sex, type Activity,
} from "../domain/energy.js";
import { entryLine } from "./ingest.js";
import type { BotTurn } from "./turns.js";

export function cmdHelp(): BotTurn[] {
  return [{
    kind: "command",
    text:
      "Talk to me like a friend:\n" +
      '🎤 "had poha and chai" — logs food\n' +
      '🎤 "ran 5k this morning" — logs exercise\n' +
      '🎤 "weighed 81.5" — logs weight\n' +
      "📷 photo of your plate — I'll estimate calories\n" +
      '💬 "why am I not losing weight?" — I\'ll look at your data\n\n' +
      "Narrate a whole day at once, that works too.\n\n" +
      "/today — today's log and budget\n/budget — view or set your daily target\n/streak — logging streak\n/undo — remove last entry",
  }];
}

export function cmdToday(user: User): BotTurn[] {
  const entries = todayEntries(user);
  if (entries.length === 0) {
    return [{ text: "Nothing logged today yet. Tell me what you've eaten.", kind: "command" }];
  }
  const lines = entries.map((e) => entryLine(e.kind, e.name, entryKcal(e), null));
  return [{ text: `${lines.join("\n")}\n\n${tallyLine(computeTally(user))}`, kind: "command" }];
}

export function cmdStreak(user: User): BotTurn[] {
  const streak = currentStreak(user);
  return [{
    kind: "command",
    text: streak === 0
      ? "No streak yet — log one thing today and it starts."
      : `🔥 ${streak} day${streak === 1 ? "" : "s"} logging streak. Showing up is the whole game.`,
  }];
}

export function cmdUndo(user: User): BotTurn[] {
  const last = db
    .prepare("SELECT * FROM entries WHERE user_id = ? AND day_local = ? ORDER BY id DESC LIMIT 1")
    .get(user.id, dayLocal(user.tz)) as Entry | undefined;
  if (!last) {
    return [{ text: "Nothing to undo today.", kind: "command" }];
  }
  db.prepare("DELETE FROM entries WHERE id = ?").run(last.id);
  return [{
    text: `Removed: ${last.name} (~${entryKcal(last)} kcal).\n${tallyLine(computeTally(user))}`,
    kind: "command",
  }];
}

export function cmdBudget(user: User, arg = ""): BotTurn[] {
  const energy = hasEnergyProfile(user)
    ? baseEnergy({
        weight_kg: user.weight_kg!,
        height_cm: user.height_cm!,
        age: user.age!,
        sex: user.sex as Sex,
        activity: user.activity as Activity,
      })
    : null;
  const floor = user.sex ? safeFloorKcal(user.sex as Sex) : null;

  if (!arg) {
    if (user.daily_budget_units == null) {
      return [{ text: "No budget set yet — run /start to set one up.", kind: "command" }];
    }
    const lines = [
      `Daily budget: ~${formatKcal(unitsToKcal(user.daily_budget_units))} kcal. Exercise earns some back.`,
    ];
    if (energy) {
      lines.push(`Your maintenance ≈ ${energy.tdee} kcal/day; resting burn ≈ ${energy.bmr} kcal.`);
    }
    lines.push("Set your own: /budget 1900");
    return [{ text: lines.join("\n\n"), kind: "command" }];
  }

  const parsed = parseBudgetArg(arg);
  if (!parsed) {
    return [{ text: "Try: /budget 1900", kind: "command" }];
  }
  db.prepare("UPDATE users SET daily_budget_units = ? WHERE id = ?").run(parsed.units, user.id);
  const kcal = unitsToKcal(parsed.units);

  let msg = `Budget set: ~${formatKcal(kcal)} kcal/day. Exercise earns some back.`;
  if (floor && kcal < floor) {
    msg += `\n\nHeads up: that's below a safe daily minimum (~${floor} kcal). Fine short-term, but hard to sustain — nudge it up if you feel wiped.`;
  }
  return [{ text: msg, kind: "command" }];
}

/** Adjust an entry's kcal by delta (e.g. -50, +100). Floors at 10 kcal. */
export function adjustEntryKcal(user: User, entryId: number, delta: number): BotTurn[] {
  const entry = db
    .prepare("SELECT * FROM entries WHERE id = ? AND user_id = ?")
    .get(entryId, user.id) as Entry | undefined;
  if (!entry) {
    return [{ text: "Entry no longer exists.", kind: "error" }];
  }
  const next = Math.max(10, entryKcal(entry) + delta);
  db.prepare("UPDATE entries SET kcal_estimate = ? WHERE id = ?").run(next, entry.id);
  saveOverride(user.id, entry.name, next);
  const fresh = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as User;
  return [{
    kind: "entry",
    text: entryLine(entry.kind, entry.name, next, null),
    entry: {
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      kcal: next,
      confidence: null,
    },
  }, {
    kind: "system",
    text: `${entry.name} = ~${formatKcal(next)} kcal, remembered. ${formatKcal(computeTally(fresh).remainingKcal)} kcal left.`,
  }];
}

/** Set absolute kcal (used by sim / spoken paths). */
export function setEntryKcal(user: User, entryId: number, kcal: number): BotTurn[] {
  const entry = db
    .prepare("SELECT * FROM entries WHERE id = ? AND user_id = ?")
    .get(entryId, user.id) as Entry | undefined;
  if (!entry) {
    return [{ text: "Entry no longer exists.", kind: "error" }];
  }
  const next = Math.max(10, Math.round(kcal));
  db.prepare("UPDATE entries SET kcal_estimate = ? WHERE id = ?").run(next, entry.id);
  saveOverride(user.id, entry.name, next);
  const fresh = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as User;
  return [{
    kind: "entry",
    text: entryLine(entry.kind, entry.name, next, null),
    entry: {
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      kcal: next,
      confidence: null,
    },
  }, {
    kind: "system",
    text: `${entry.name} = ~${formatKcal(next)} kcal, remembered. ${formatKcal(computeTally(fresh).remainingKcal)} kcal left.`,
  }];
}

export function deleteEntry(user: User, entryId: number): BotTurn[] {
  const entry = db
    .prepare("SELECT * FROM entries WHERE id = ? AND user_id = ?")
    .get(entryId, user.id) as Entry | undefined;
  if (!entry) {
    return [{ text: "Entry no longer exists.", kind: "error" }];
  }
  db.prepare("DELETE FROM entries WHERE id = ?").run(entry.id);
  const fresh = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as User;
  return [{
    kind: "system",
    text: `❌ ${entry.name} — removed\n${tallyLine(computeTally(fresh))}`,
  }];
}
