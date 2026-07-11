import { db, type Entry, type User, dayLocal } from "../db/index.js";
import { EXERCISE_CREDIT } from "./credit.js";
import { unitsToKcal } from "./energy.js";

export interface Tally {
  foodKcal: number;
  earnedKcal: number;
  budgetKcal: number;
  remainingKcal: number;
}

export function todayEntries(user: User): Entry[] {
  return db
    .prepare("SELECT * FROM entries WHERE user_id = ? AND day_local = ? ORDER BY logged_at")
    .all(user.id, dayLocal(user.tz)) as Entry[];
}

export function entryKcal(entry: { kcal_estimate: number | null }): number {
  if (entry.kcal_estimate != null && Number.isFinite(entry.kcal_estimate)) {
    return Math.round(entry.kcal_estimate);
  }
  return 200;
}

export function computeTally(user: User): Tally {
  const budgetKcal = user.daily_budget_units != null
    ? unitsToKcal(user.daily_budget_units)
    : 2000;
  let foodKcal = 0;
  let earnedKcal = 0;
  for (const entry of todayEntries(user)) {
    const kcal = entryKcal(entry);
    if (entry.kind === "food") foodKcal += kcal;
    else earnedKcal += Math.round(kcal * EXERCISE_CREDIT);
  }
  return {
    foodKcal,
    earnedKcal,
    budgetKcal,
    remainingKcal: budgetKcal - foodKcal + earnedKcal,
  };
}

export function formatKcal(kcal: number): string {
  return String(Math.round(kcal));
}

export function tallyLine(tally: Tally): string {
  const used = Math.max(tally.foodKcal - tally.earnedKcal, 0);
  const filled = Math.min(
    Math.max(Math.round((used / Math.max(tally.budgetKcal, 1)) * 10), 0),
    10,
  );
  const bar = "▓".repeat(filled) + "░".repeat(10 - filled);
  if (tally.remainingKcal >= 0) {
    return `${bar}  ~${formatKcal(tally.remainingKcal)} kcal left today`;
  }
  return `${bar}  ~${formatKcal(-tally.remainingKcal)} kcal over today — tomorrow is a new day`;
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
