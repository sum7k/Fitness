import { db, type Entry, type User, dayLocal } from "../db/index.js";
import { SIZE_UNITS, EXERCISE_CREDIT, isSize } from "./sizes.js";

export interface Tally {
  foodUnits: number;
  earnedUnits: number;
  budget: number;
  remaining: number;
}

export function todayEntries(user: User): Entry[] {
  return db
    .prepare("SELECT * FROM entries WHERE user_id = ? AND day_local = ? ORDER BY logged_at")
    .all(user.id, dayLocal(user.tz)) as Entry[];
}

export function computeTally(user: User): Tally {
  const budget = user.daily_budget_units ?? 10;
  let foodUnits = 0;
  let earnedUnits = 0;
  for (const entry of todayEntries(user)) {
    if (!isSize(entry.size)) continue;
    const units = SIZE_UNITS[entry.size];
    if (entry.kind === "food") foodUnits += units;
    else earnedUnits += units * EXERCISE_CREDIT;
  }
  return { foodUnits, earnedUnits, budget, remaining: budget - foodUnits + earnedUnits };
}

export function tallyLine(tally: Tally): string {
  const filled = Math.min(
    Math.max(Math.round((tally.foodUnits - tally.earnedUnits) / tally.budget * 10), 0),
    10,
  );
  const bar = "▓".repeat(filled) + "░".repeat(10 - filled);
  if (tally.remaining >= 0) {
    return `${bar}  ~${formatUnits(tally.remaining)} M left today`;
  }
  return `${bar}  ~${formatUnits(-tally.remaining)} M over today — tomorrow is a new day`;
}

export function formatUnits(units: number): string {
  const rounded = Math.round(units * 4) / 4;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, "");
}

export function currentStreak(user: User): number {
  const days = db
    .prepare(
      "SELECT DISTINCT day_local FROM entries WHERE user_id = ? ORDER BY day_local DESC LIMIT 365",
    )
    .all(user.id) as Array<{ day_local: string }>;
  if (days.length === 0) return 0;

  const today = dayLocal(user.tz);
  const yesterday = dayLocal(user.tz, new Date(Date.now() - 24 * 3600 * 1000));
  // Streak is alive if the newest logged day is today or yesterday.
  if (days[0].day_local !== today && days[0].day_local !== yesterday) return 0;

  let streak = 1;
  for (let i = 1; i < days.length; i++) {
    const prev = new Date(days[i - 1].day_local);
    const curr = new Date(days[i].day_local);
    const gapDays = (prev.getTime() - curr.getTime()) / (24 * 3600 * 1000);
    if (gapDays === 1) streak++;
    else break;
  }
  return streak;
}
