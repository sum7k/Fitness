import { db, type User } from "../db/index.js";
import { formatUnits } from "../domain/tally.js";
import {
  baseEnergy, budgetFor, bmi, clampRateKgWk, rateToDailyAdjust, paceToRate, hasEnergyProfile,
  type Sex, type Activity, type Pace,
} from "../domain/energy.js";
import {
  onboardingTurn, type OnboardProfile, type OnboardInputPart, type OnboardTurn,
} from "../llm/onboard.js";
import type { BotTurn } from "./turns.js";

const OPENING =
  "Hey! I'm your food-and-movement sidekick — no calorie counting, no forms. You just tell me what you eat and do, and I track it in simple sizes.\n\n" +
  "To set you up, tell me a bit about yourself and what you're after — your weight, height, age, how your usual day goes, and your goal. Talk or type, whatever's easy.";

export function beginOnboarding(user: User): BotTurn[] {
  db.prepare(
    "UPDATE users SET onboarding_state = 'chat', pending_rate = NULL WHERE id = ?",
  ).run(user.id);
  logChat(user.id, "assistant", OPENING);
  return [{ text: OPENING, kind: "onboarding" }];
}

export async function continueOnboarding(
  user: User,
  parts: OnboardInputPart[],
): Promise<BotTurn[]> {
  const history = recentChat(user.id);
  const profile = toProfile(user);

  let turn: OnboardTurn;
  try {
    turn = await onboardingTurn(parts, profile, history);
  } catch (err) {
    console.error("onboarding turn failed:", err);
    return [{ text: "Had a hiccup there — say that again?", kind: "error" }];
  }

  logChat(user.id, "user", turn.transcript);
  applyUpdates(user.id, turn.updates);
  const fresh = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as User;

  let reply = turn.message;
  const complete = hasEnergyProfile(fresh) && !!fresh.goal;

  if (turn.stage === "proposing" && complete && turn.proposed_pace != null) {
    const rate = clampRateKgWk(paceToRate(turn.proposed_pace as Pace), fresh.weight_kg!);
    db.prepare("UPDATE users SET pending_rate = ? WHERE id = ?").run(rate, fresh.id);
    const budget = computeBudget(fresh, rate);
    reply +=
      `\n\n(≈ ${formatUnits(budget.units)} M a day — one M is about a normal bowl of food, and exercise earns more back.` +
      (budget.floored ? " I've held it at a safe daily minimum." : "") +
      `)`;
  } else if (turn.stage === "confirmed" && complete && fresh.pending_rate != null) {
    const budget = computeBudget(fresh, fresh.pending_rate);
    db.prepare(
      "UPDATE users SET daily_budget_units = ?, pace = ?, onboarding_state = NULL, pending_rate = NULL WHERE id = ?",
    ).run(budget.units, rateLabel(fresh.pending_rate), fresh.id);
    reply += "\n\n" + doneFooter(budget.units, fresh.name);
  }

  logChat(user.id, "assistant", reply);
  trimChat(user.id);
  return [{ text: reply, kind: "onboarding" }];
}

function toProfile(user: User): OnboardProfile {
  const canBmi = user.weight_kg && user.height_cm;
  return {
    name: user.name,
    weight_kg: user.weight_kg,
    height_cm: user.height_cm,
    age: user.age,
    sex: user.sex,
    activity: user.activity,
    exercise_goal_days: user.exercise_goal_days,
    goal: user.goal,
    bmi: canBmi ? bmi(user.weight_kg!, user.height_cm!) : null,
  };
}

export function applyUpdates(userId: number, u: OnboardTurn["updates"]) {
  const set = (col: string, val: number | string) =>
    db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(val, userId);

  if (u.name != null) {
    const name = u.name.trim().slice(0, 40);
    if (name.length >= 1) set("name", name);
  }
  if (u.weight_kg != null && u.weight_kg >= 25 && u.weight_kg <= 350) set("weight_kg", u.weight_kg);
  if (u.height_cm != null && u.height_cm >= 100 && u.height_cm <= 250) set("height_cm", u.height_cm);
  if (u.age != null && u.age >= 13 && u.age <= 100) set("age", u.age);
  if (u.sex === "male" || u.sex === "female") set("sex", u.sex);
  if (u.activity && ["sedentary", "light", "moderate", "active"].includes(u.activity)) {
    set("activity", u.activity);
  }
  if (u.exercise_goal_days != null && u.exercise_goal_days >= 0 && u.exercise_goal_days <= 7) {
    set("exercise_goal_days", Math.round(u.exercise_goal_days));
  }
  if (u.goal && ["lose", "maintain", "gain"].includes(u.goal)) set("goal", u.goal);
}

function computeBudget(user: User, rateKgWk: number) {
  const base = baseEnergy({
    weight_kg: user.weight_kg!,
    height_cm: user.height_cm!,
    age: user.age!,
    sex: user.sex as Sex,
    activity: user.activity as Activity,
  });
  return budgetFor(base, user.sex as Sex, rateToDailyAdjust(rateKgWk));
}

function rateLabel(rateKgWk: number): string {
  if (rateKgWk === 0) return "maintain";
  return `${rateKgWk > 0 ? "+" : ""}${rateKgWk}kg/wk`;
}

function doneFooter(units: number, name: string | null): string {
  return (
    `You're all set${name ? `, ${name}` : ""} — daily budget about ${formatUnits(units)} M. Think of an M as a normal bowl of food (~a dal-rice bowl).\n\n` +
    `Now just tell me things, any time:\n` +
    `🎤 voice: "had poha and chai for breakfast"\n` +
    `⌨️ text: "2 rotis with dal, then walked 20 min"\n` +
    `📷 photo of your plate\n` +
    `⚖️ "weighed 81.5 today"\n` +
    `💬 or ask me anything — "how am I doing this week?"\n\n` +
    `Change your target anytime: /budget`
  );
}

function logChat(userId: number, role: "user" | "assistant", text: string) {
  db.prepare("INSERT INTO chat_log (user_id, role, text) VALUES (?, ?, ?)").run(userId, role, text);
}

function recentChat(userId: number): Array<{ role: "user" | "assistant"; text: string }> {
  return (
    db
      .prepare("SELECT role, text FROM chat_log WHERE user_id = ? ORDER BY id DESC LIMIT 10")
      .all(userId) as Array<{ role: "user" | "assistant"; text: string }>
  ).reverse();
}

function trimChat(userId: number) {
  db.prepare(
    "DELETE FROM chat_log WHERE user_id = ? AND id NOT IN (SELECT id FROM chat_log WHERE user_id = ? ORDER BY id DESC LIMIT 20)",
  ).run(userId, userId);
}
