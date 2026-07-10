// Energy math: Mifflin-St Jeor BMR → TDEE → daily budget.
// The LLM gathers facts and proposes a weekly rate; ALL arithmetic + safety
// clamping lives here so a chatty model can never set an unsafe budget.

export type Sex = "male" | "female";
export type Activity = "sedentary" | "light" | "moderate" | "active";
export type BmiClass = "underweight" | "normal" | "overweight" | "obese";

// Baseline lifestyle only (occupational + daily movement), EXCLUDING intentional
// workouts — those are logged and earn budget back, so folding them in here would
// double-count. sedentary = desk job, active = physical-labor job.
export const ACTIVITY_FACTOR: Record<Activity, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
};

export const KCAL_PER_UNIT = 200; // 1 budget unit = one M
const KCAL_PER_KG_FAT = 7700; // energy in a kg of body fat
const MAX_WEEKLY_LOSS_FRACTION = 0.01; // ≤ 1% bodyweight/week (SPEC §7)

// Safe daily minimum. Not BMR-anchored: for a sedentary obese user TDEE is only
// ~1.2×BMR, so a BMR floor would collapse every fast loss plan to the same number.
// These are the widely used clinical minimums for self-directed dieting instead.
export function safeFloorKcal(sex: Sex): number {
  return sex === "male" ? 1500 : 1200;
}

export interface Base {
  bmr: number; // resting burn
  tdee: number; // maintenance (BMR × activity)
}

export function mifflinBmr(weight_kg: number, height_cm: number, age: number, sex: Sex): number {
  return 10 * weight_kg + 6.25 * height_cm - 5 * age + (sex === "male" ? 5 : -161);
}

export function baseEnergy(i: {
  weight_kg: number;
  height_cm: number;
  age: number;
  sex: Sex;
  activity: Activity;
}): Base {
  const bmr = mifflinBmr(i.weight_kg, i.height_cm, i.age, i.sex);
  const tdee = bmr * (ACTIVITY_FACTOR[i.activity] ?? ACTIVITY_FACTOR.sedentary);
  return { bmr: Math.round(bmr), tdee: Math.round(tdee) };
}

export interface Budget {
  target: number; // kcal/day after adjust, clamped to the safe floor
  units: number; // daily_budget_units
  floored: boolean; // true if the safe floor bit
}

// Apply a daily kcal adjustment (negative = deficit) to maintenance.
export function budgetFor(base: Base, sex: Sex, dailyAdjustKcal: number): Budget {
  const floor = safeFloorKcal(sex);
  const raw = base.tdee + dailyAdjustKcal;
  const target = Math.max(raw, floor);
  return { target: Math.round(target), units: kcalToUnits(target), floored: raw < floor };
}

// ---- pace buckets ----
// Discrete paces map to fixed weekly rates, so the budget a user sees is stable
// across turns (a free numeric rate from the LLM made the number jitter).
export type Pace = "gentle" | "steady" | "faster" | "aggressive" | "maintain" | "leangain" | "gain";

const PACE_RATE: Record<Pace, number> = {
  gentle: -0.25,
  steady: -0.5,
  faster: -0.75,
  aggressive: -1.0,
  maintain: 0,
  leangain: 0.25,
  gain: 0.5,
};

export function paceToRate(p: Pace): number {
  return PACE_RATE[p] ?? 0;
}

// ---- weekly rate → daily kcal ----

// Clamp a proposed weekly rate (signed kg/week) to the ≤1%-bodyweight/week guardrail.
// Loss and gain are both bounded; the LLM's proposal is only a suggestion.
export function clampRateKgWk(rateKgWk: number, weight_kg: number): number {
  const cap = MAX_WEEKLY_LOSS_FRACTION * weight_kg;
  return Math.max(-cap, Math.min(cap, rateKgWk));
}

export function rateToDailyAdjust(rateKgWk: number): number {
  return Math.round((rateKgWk * KCAL_PER_KG_FAT) / 7);
}

// ---- BMI ----

export function bmi(weight_kg: number, height_cm: number): number {
  const m = height_cm / 100;
  return weight_kg / (m * m);
}

export function bmiClass(b: number): BmiClass {
  if (b < 18.5) return "underweight";
  if (b < 25) return "normal";
  if (b < 30) return "overweight";
  return "obese";
}

// ---- unit helpers ----

export function kcalToUnits(kcal: number): number {
  return Math.round((kcal / KCAL_PER_UNIT) * 2) / 2; // nearest 0.5 M
}

export function unitsToKcal(units: number): number {
  return Math.round(units * KCAL_PER_UNIT);
}

// Parse a /budget argument. Accepts "1900", "1900kcal", "10m", "10 units".
// Auto-detect when no unit given: >= 60 is read as kcal, else as M.
export function parseBudgetArg(raw: string): { units: number; wasKcal: boolean } | null {
  const m = raw.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(kcal|cal|c|m|unit|units)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2];
  let wasKcal: boolean;
  if (unit === "m" || unit === "unit" || unit === "units") wasKcal = false;
  else if (unit === "kcal" || unit === "cal" || unit === "c") wasKcal = true;
  else wasKcal = n >= 60;
  const units = wasKcal ? kcalToUnits(n) : Math.round(n * 2) / 2;
  return { units, wasKcal };
}

export function hasEnergyProfile(u: {
  weight_kg: number | null;
  height_cm: number | null;
  age: number | null;
  sex: string | null;
  activity: string | null;
}): boolean {
  return !!(u.weight_kg && u.height_cm && u.age && u.sex && u.activity);
}
