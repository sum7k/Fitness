import { db, dayLocal, type Entry, type User } from "../db/index.js";
import { saveOverride } from "../domain/sizing.js";
import { computeTally, tallyLine, formatUnits, currentStreak, todayEntries } from "../domain/tally.js";
import { isSize, type Size } from "../domain/sizes.js";
import {
  baseEnergy, safeFloorKcal, parseBudgetArg, unitsToKcal, hasEnergyProfile,
  type Sex, type Activity,
} from "../domain/energy.js";
import { entryLine, kcalMidFor } from "./ingest.js";
import type { BotTurn } from "./turns.js";

export function cmdHelp(): BotTurn[] {
  return [{
    kind: "command",
    text:
      "Talk to me like a friend:\n" +
      '🎤 "had poha and chai" — logs food\n' +
      '🎤 "ran 5k this morning" — logs exercise\n' +
      '🎤 "weighed 81.5" — logs weight\n' +
      "📷 photo of your plate — I'll size it\n" +
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
  const lines = entries.map((e) => entryLine(e.kind, e.name, e.size, null));
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
    text: `Removed: ${last.name} (${last.size}).\n${tallyLine(computeTally(user))}`,
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
      `Daily budget: ~${formatUnits(user.daily_budget_units)} M (≈ ${unitsToKcal(user.daily_budget_units)} kcal). Exercise earns more back.`,
    ];
    if (energy) {
      lines.push(`Your maintenance ≈ ${energy.tdee} kcal/day; resting burn ≈ ${energy.bmr} kcal.`);
    }
    lines.push("Set your own: /budget 1900  (calories) or /budget 10M (sizes).");
    return [{ text: lines.join("\n\n"), kind: "command" }];
  }

  const parsed = parseBudgetArg(arg);
  if (!parsed) {
    return [{ text: "Try: /budget 1900  (calories) or /budget 10M (sizes).", kind: "command" }];
  }
  db.prepare("UPDATE users SET daily_budget_units = ? WHERE id = ?").run(parsed.units, user.id);

  let msg = `Budget set: ~${formatUnits(parsed.units)} M (≈ ${unitsToKcal(parsed.units)} kcal/day). Exercise earns more back.`;
  if (floor && unitsToKcal(parsed.units) < floor) {
    msg += `\n\nHeads up: that's below a safe daily minimum (~${floor} kcal). Fine short-term, but hard to sustain — nudge it up if you feel wiped.`;
  }
  return [{ text: msg, kind: "command" }];
}

export function correctEntrySize(user: User, entryId: number, newSize: string): BotTurn[] {
  const entry = db
    .prepare("SELECT * FROM entries WHERE id = ? AND user_id = ?")
    .get(entryId, user.id) as Entry | undefined;
  if (!entry) {
    return [{ text: "Entry no longer exists.", kind: "error" }];
  }
  if (!isSize(newSize)) {
    return [{ text: `Unknown size: ${newSize}`, kind: "error" }];
  }
  db.prepare("UPDATE entries SET size = ?, kcal_estimate = ? WHERE id = ?").run(
    newSize, kcalMidFor(newSize), entry.id,
  );
  saveOverride(user.id, entry.name, newSize, kcalMidFor(newSize));
  const fresh = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as User;
  return [{
    kind: "entry",
    text: entryLine(entry.kind, entry.name, newSize, null),
    entry: {
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      size: newSize,
      confidence: null,
    },
  }, {
    kind: "system",
    text: `${entry.name} = ${newSize}, remembered. ${formatUnits(computeTally(fresh).remaining)} M left.`,
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

export type { Size };
