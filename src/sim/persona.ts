import { chat, parseJsonLenient } from "../llm/openrouter.js";
import { config } from "../config.js";
import type { Scenario } from "./scenarios.js";

export interface Persona {
  name: string;
  age: number;
  locale: string;
  language_mix: "english" | "hinglish" | "hindi_light";
  goal: "lose" | "maintain" | "gain";
  weight_kg: number;
  height_cm: number;
  sex: "male" | "female";
  activity: "sedentary" | "light" | "moderate" | "active";
  exercise_goal_days: number;
  diet: string;
  personality: string;
  quirks: string[];
  speaking_style: string;
}

const PERSONA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    age: { type: "number" },
    locale: { type: "string" },
    language_mix: { type: "string", enum: ["english", "hinglish", "hindi_light"] },
    goal: { type: "string", enum: ["lose", "maintain", "gain"] },
    weight_kg: { type: "number" },
    height_cm: { type: "number" },
    sex: { type: "string", enum: ["male", "female"] },
    activity: { type: "string", enum: ["sedentary", "light", "moderate", "active"] },
    exercise_goal_days: { type: "number" },
    diet: { type: "string" },
    personality: { type: "string" },
    quirks: { type: "array", items: { type: "string" } },
    speaking_style: { type: "string" },
  },
  required: [
    "name", "age", "locale", "language_mix", "goal", "weight_kg", "height_cm",
    "sex", "activity", "exercise_goal_days", "diet", "personality", "quirks", "speaking_style",
  ],
};

export async function inventPersona(scenario: Scenario): Promise<Persona> {
  const messages = [
    {
      role: "system" as const,
      content:
        "Invent a realistic fitness-app user persona for a simulation. " +
        "Target: age 20–45, smartphone-native, has tried tracking apps before. " +
        "Prefer South Asian / Indian urban context unless the scenario says otherwise. " +
        "Be specific and vivid — not generic. quirks: 2–4 concrete habits. " +
        "speaking_style: how they text (short, typos ok, emoji rare).",
    },
    {
      role: "user" as const,
      content:
        `Scenario: ${scenario.id}\nStress test: ${scenario.stress}\n` +
        `Persona hint: ${scenario.personaHint}\n\nInvent the persona JSON.`,
    },
  ];
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await chat({
        model: config.modelSimUser,
        maxTokens: 800,
        reasoning: false,
        jsonSchema: { name: "persona", schema: PERSONA_SCHEMA },
        messages,
      });
      return parseJsonLenient<Persona>(raw);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
