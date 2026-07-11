import { chat, parseJsonLenient, type ChatMessage } from "./openrouter.js";
import { config } from "../config.js";

// What we know about THIS user so far. Assembled by code from the user's own row —
// the model never queries anything and never sees another user's data (see buildOnboardMessages).
export interface OnboardProfile {
  name: string | null;
  weight_kg: number | null;
  height_cm: number | null;
  age: number | null;
  sex: string | null;
  activity: string | null;
  exercise_goal_days: number | null;
  goal: string | null;
  bmi: number | null; // computed by code when height+weight known, to guide the model's pace pick
}

export type ProposedPace =
  | "gentle" | "steady" | "faster" | "aggressive" | "maintain" | "leangain" | "gain" | null;

export interface OnboardTurn {
  transcript: string;
  updates: {
    name: string | null;
    weight_kg: number | null;
    height_cm: number | null;
    age: number | null;
    sex: "male" | "female" | null;
    activity: "sedentary" | "light" | "moderate" | "active" | null;
    exercise_goal_days: number | null;
    goal: "lose" | "maintain" | "gain" | null;
  };
  stage: "gathering" | "proposing" | "confirmed";
  proposed_pace: ProposedPace; // a discrete bucket, not a number — code maps it to a rate + budget
  message: string;
}

const TURN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    transcript: { type: "string" },
    updates: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: ["string", "null"] },
        weight_kg: { type: ["number", "null"] },
        height_cm: { type: ["number", "null"] },
        age: { type: ["number", "null"] },
        sex: { type: ["string", "null"], enum: ["male", "female", null] },
        activity: {
          type: ["string", "null"],
          enum: ["sedentary", "light", "moderate", "active", null],
        },
        exercise_goal_days: { type: ["number", "null"] },
        goal: { type: ["string", "null"], enum: ["lose", "maintain", "gain", null] },
      },
      required: [
        "name", "weight_kg", "height_cm", "age", "sex", "activity", "exercise_goal_days", "goal",
      ],
    },
    stage: { type: "string", enum: ["gathering", "proposing", "confirmed"] },
    proposed_pace: {
      type: ["string", "null"],
      enum: ["gentle", "steady", "faster", "aggressive", "maintain", "leangain", "gain", null],
    },
    message: { type: "string" },
  },
  required: ["transcript", "updates", "stage", "proposed_pace", "message"],
};

const SYSTEM_PROMPT = `You onboard a new user for a fitness bot that estimates calories from what they tell you (voice, text, or photo). Have a short, warm, natural conversation to learn what you need, then propose a plan.

You know ONLY this one user. You have no database access and no knowledge of any other user. Never reference, compare to, or reveal anyone else — you have nothing to reveal.

BUDGET: the app sets a daily calorie target. You never compute or state that number yourself — the app appends it. If they ask how tracking works, say they just tell you what they ate/did and you estimate calories (rough is fine).

COLLECT (ask about what's missing, one topic at a time, friendly and brief):
- name (first name, if they mention it).
- weight_kg, height_cm, age, sex (male/female).
- activity = BASELINE lifestyle only, EXCLUDING workouts. Map their job/daily movement: desk job → sedentary; on feet sometimes → light; on feet a lot → moderate; physical-labor job → active. Do NOT raise this for planned gym sessions — those are logged separately and earn budget back.
- exercise_goal_days = how many days/week they WANT to work out (0-7). A motivational target only.
- goal = lose | maintain | gain (infer from what they say).

Only put a field in "updates" if you learned or changed it this turn; otherwise null.

PACE (choose a discrete bucket, never a number):
- Loss: "gentle" (slowest), "steady", "faster", "aggressive" (fastest ~1kg/week).
- "maintain" for maintenance. Gain: "leangain", "gain".
Pick a SAFE, sensible pace: a higher-BMI person can go faster; a normal-BMI person should go gentle. If the user asks a number question like "how much to lose 1 kg a week", answer by picking the matching pace ("aggressive") — do NOT state a figure.

CRITICAL: never write any calorie number in "message" — the app appends the daily target. Never mention BMI or weight-per-week figures to the user either; BMI is context for your pace choice only. Once you propose a pace, keep proposing that SAME pace on later turns unless the user explicitly asks to change it (so the budget they see stays stable).

STAGES:
- "gathering": still missing weight, height, age, sex, activity, or goal. message = a brief question for what's missing. Also use this to answer side questions.
- "proposing": you have weight, height, age, sex, activity, and goal. Set proposed_pace. message = describe the pace in plain words and ask if it sounds right — no numbers.
- "confirmed": the user has clearly agreed to the proposed plan. Keep proposed_pace set. message = a short warm confirmation, with NO further question.
- If the user's reply already agrees ("sounds good", "chalo let's do this"), go straight to "confirmed" — do not re-ask the pace question, even if their message also contained a side question (answer it briefly inside the confirmation).

transcript: for audio, a verbatim transcription; for text, echo the text.`;


export type OnboardInputPart =
  | { type: "text"; text: string }
  | { type: "input_audio"; input_audio: { data: string; format: "mp3" | "wav" } };

// Build the messages sent to the model. PURE + user-scoped: the only user data that
// can appear is `profile` (this user's row) and `history` (this user's conversation).
// No other user's data is reachable from here. Exported for the isolation test.
export function buildOnboardMessages(
  profile: OnboardProfile,
  history: Array<{ role: "user" | "assistant"; text: string }>,
  parts: OnboardInputPart[],
): ChatMessage[] {
  const known = [
    `name: ${profile.name ?? "unknown"}`,
    `weight_kg: ${profile.weight_kg ?? "unknown"}`,
    `height_cm: ${profile.height_cm ?? "unknown"}`,
    `age: ${profile.age ?? "unknown"}`,
    `sex: ${profile.sex ?? "unknown"}`,
    `activity: ${profile.activity ?? "unknown"}`,
    `exercise_goal_days: ${profile.exercise_goal_days ?? "unknown"}`,
    `goal: ${profile.goal ?? "unknown"}`,
    `bmi: ${profile.bmi != null ? profile.bmi.toFixed(1) : "unknown"}`,
  ].join("\n");

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: `What you know about this user so far:\n${known}` },
    ...history.map((m) => ({ role: m.role, content: m.text })),
    { role: "user", content: parts },
  ];
}

export async function onboardingTurn(
  parts: OnboardInputPart[],
  profile: OnboardProfile,
  history: Array<{ role: "user" | "assistant"; text: string }>,
): Promise<OnboardTurn> {
  const messages = buildOnboardMessages(profile, history, parts);
  let lastErr: unknown;
  // Gemini occasionally returns malformed/empty JSON; one retry clears most of it.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await chat({
        model: config.modelCheap, // multimodal — accepts voice-note audio; DeepSeek can't
        messages,
        jsonSchema: { name: "onboard_turn", schema: TURN_SCHEMA },
        maxTokens: 1200,
      });
      return parseJsonLenient<OnboardTurn>(raw);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
