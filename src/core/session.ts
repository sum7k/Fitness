import { db, getOrCreateUser, dayLocal, normalizeName, type User } from "../db/index.js";
import { computeTally, formatUnits, currentStreak, todayEntries } from "../domain/tally.js";
import { beginOnboarding, continueOnboarding } from "./onboarding.js";
import { ingestText, entryLine } from "./ingest.js";
import {
  cmdHelp, cmdToday, cmdStreak, cmdUndo, cmdBudget,
  correctEntrySize, deleteEntry,
} from "./commands.js";
import type { BotTurn } from "./turns.js";

export type { BotTurn } from "./turns.js";

export interface SessionSnapshot {
  onboarding: boolean;
  name: string | null;
  goal: string | null;
  weight_kg: number | null;
  daily_budget_units: number | null;
  streak: number;
  today: {
    entries: Array<{ id: number; kind: string; name: string; size: string }>;
    food_units: number;
    earned_units: number;
    remaining: number;
  };
}

export type CommandName = "today" | "streak" | "undo" | "help" | "budget";

/** Headless bot session — same domain logic as Telegram, no grammY. */
export class BotSession {
  readonly tgUserId: number;
  private userId: number;

  constructor(tgUserId?: number) {
    // Synthetic ids stay far from real Telegram user ids.
    this.tgUserId = tgUserId ?? 9_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
    const user = getOrCreateUser(this.tgUserId);
    this.userId = user.id;
  }

  private load(): User {
    return db.prepare("SELECT * FROM users WHERE id = ?").get(this.userId) as User;
  }

  start(): BotTurn[] {
    return beginOnboarding(this.load());
  }

  async sendText(text: string): Promise<BotTurn[]> {
    const user = this.load();
    const trimmed = text.trim();
    if (trimmed.startsWith("/")) {
      return this.dispatchCommand(trimmed);
    }
    if (user.onboarding_state === "chat") {
      return continueOnboarding(user, [{ type: "text", text }]);
    }
    return ingestText(user, text);
  }

  async command(name: CommandName, arg = ""): Promise<BotTurn[]> {
    const user = this.load();
    switch (name) {
      case "help": return cmdHelp();
      case "today": return cmdToday(user);
      case "streak": return cmdStreak(user);
      case "undo": return cmdUndo(user);
      case "budget": return cmdBudget(user, arg);
    }
  }

  correctSize(entryId: number, size: string): BotTurn[] {
    return correctEntrySize(this.load(), entryId, size);
  }

  deleteEntry(entryId: number): BotTurn[] {
    return deleteEntry(this.load(), entryId);
  }

  snapshot(): SessionSnapshot {
    const user = this.load();
    const tally = computeTally(user);
    const entries = todayEntries(user);
    return {
      onboarding: user.onboarding_state === "chat",
      name: user.name,
      goal: user.goal,
      weight_kg: user.weight_kg,
      daily_budget_units: user.daily_budget_units,
      streak: currentStreak(user),
      today: {
        entries: entries.map((e) => ({
          id: e.id, kind: e.kind, name: e.name, size: e.size,
        })),
        food_units: tally.foodUnits,
        earned_units: tally.earnedUnits,
        remaining: tally.remaining,
      },
    };
  }

  /** Seed past logging days + weigh-ins so buddy has history to ground on. */
  seedHistory(opts: {
    days: number;
    weight_kg: number;
    weightDeltaPerDay?: number;
    foodsPerDay?: Array<{ name: string; size: string; kind?: "food" | "exercise" }>;
  }): void {
    const user = this.load();
    const foods = opts.foodsPerDay ?? [
      { name: "poha", size: "M" },
      { name: "dal rice", size: "L" },
      { name: "chai", size: "S" },
      { name: "walk", size: "S", kind: "exercise" as const },
    ];
    const insert = db.prepare(
      `INSERT INTO entries (user_id, kind, name, name_normalized, size, kcal_estimate,
                            meal_slot, confidence, source, day_local, logged_at)
       VALUES (?, ?, ?, ?, ?, ?, 'unknown', 'high', 'text', ?, ?)`,
    );
    const insertW = db.prepare(
      `INSERT INTO weights (user_id, weight_kg, day_local, measured_at) VALUES (?, ?, ?, ?)`,
    );

    for (let d = opts.days; d >= 1; d--) {
      const date = new Date(Date.now() - d * 24 * 3600 * 1000);
      const day = dayLocal(user.tz, date);
      const iso = date.toISOString().replace("T", " ").slice(0, 19);
      for (const f of foods) {
        const kind = f.kind ?? "food";
        insert.run(
          user.id, kind, f.name, normalizeName(f.name), f.size,
          null, day, iso,
        );
      }
      const delta = (opts.weightDeltaPerDay ?? 0) * (opts.days - d);
      insertW.run(user.id, opts.weight_kg + delta, day, iso);
    }
  }

  /** Format today's entries the way the bot shows them (for SimUser context). */
  formatToday(): string {
    const user = this.load();
    const entries = todayEntries(user);
    if (entries.length === 0) return "(nothing logged today)";
    return entries.map((e) => entryLine(e.kind, e.name, e.size, null)).join("\n") +
      `\n${formatUnits(computeTally(user).remaining)} M left`;
  }

  private dispatchCommand(raw: string): BotTurn[] {
    const [cmd, ...rest] = raw.slice(1).split(/\s+/);
    const arg = rest.join(" ");
    const user = this.load();
    switch (cmd.toLowerCase()) {
      case "start": return this.start();
      case "help": return cmdHelp();
      case "today": return cmdToday(user);
      case "streak": return cmdStreak(user);
      case "undo": return cmdUndo(user);
      case "budget": return cmdBudget(user, arg);
      default:
        return [{ text: `Unknown command /${cmd}. Try /help.`, kind: "system" }];
    }
  }
}
