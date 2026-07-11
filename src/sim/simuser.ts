import { chat, parseJsonLenient } from "../llm/openrouter.js";
import { config } from "../config.js";
import type { BotTurn, SessionSnapshot } from "../core/session.js";
import type { Persona } from "./persona.js";
import type { Scenario } from "./scenarios.js";

export type SimAction =
  | { action: "text"; text: string }
  | { action: "correct"; entry_id: number; kcal: number }
  | { action: "delete"; entry_id: number }
  | { action: "command"; command: "today" | "streak" | "undo" | "help" | "budget"; arg?: string }
  | { action: "done"; reason: string };

const ACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["text", "correct", "delete", "command", "done"] },
    text: { type: ["string", "null"] },
    entry_id: { type: ["number", "null"] },
    kcal: { type: ["number", "null"] },
    command: {
      type: ["string", "null"],
      enum: ["today", "streak", "undo", "help", "budget", null],
    },
    arg: { type: ["string", "null"] },
    reason: { type: ["string", "null"] },
  },
  required: ["action", "text", "entry_id", "kcal", "command", "arg", "reason"],
};

export interface TranscriptTurn {
  i: number;
  from: "user" | "bot";
  action?: SimAction["action"];
  text?: string;
  payload?: unknown;
  turns?: BotTurn[];
}

function formatHistory(history: TranscriptTurn[]): string {
  const lines: string[] = [];
  for (const t of history) {
    if (t.from === "user") {
      lines.push(`USER: ${t.text ?? JSON.stringify(t.payload)}`);
    } else {
      for (const bt of t.turns ?? []) {
        const chip = bt.entry ? ` [entry#${bt.entry.id} ~${bt.entry.kcal}kcal]` : "";
        lines.push(`BOT (${bt.kind})${chip}: ${bt.text}`);
      }
    }
  }
  return lines.join("\n");
}

function formatSnapshot(s: SessionSnapshot): string {
  return [
    `onboarding=${s.onboarding}`,
    `name=${s.name ?? "-"} goal=${s.goal ?? "-"} weight=${s.weight_kg ?? "-"}kg`,
    `budget=${s.daily_budget_kcal ?? "-"} kcal streak=${s.streak}`,
    `today food=${s.today.food_kcal} earned=${s.today.earned_kcal} remaining=${s.today.remaining_kcal} kcal`,
    `entries: ${s.today.entries.map((e) => `#${e.id} ${e.name}=~${e.kcal}kcal`).join(", ") || "none"}`,
  ].join("\n");
}

export async function nextSimAction(opts: {
  persona: Persona;
  scenario: Scenario;
  history: TranscriptTurn[];
  snapshot: SessionSnapshot;
  turnIndex: number;
  maxTurns: number;
}): Promise<SimAction> {
  const { persona, scenario, history, snapshot, turnIndex, maxTurns } = opts;

  const system = `You are roleplaying as a real Telegram user talking to a fitness logging bot.
You ARE this persona — never break character, never narrate, never say you are an AI.

PERSONA:
${JSON.stringify(persona, null, 2)}

SCENARIO: ${scenario.id}
${scenario.stress}
Behavior: ${scenario.behaviorHint}

RULES:
- Speak like a real person texting: short messages, imperfect, ${persona.language_mix}.
- During onboarding: answer the bot's questions; drip info naturally (1–2 facts per message is fine). Agree when a plan is proposed if it sounds reasonable for your goal.
- After onboarding: log food/exercise the way YOU would — vague quantities, multi-item, occasional weight.
- You can correct an estimate with action=correct (entry_id + kcal absolute value), delete with action=delete, or use commands (today/streak/undo/help/budget).
- Prefer action=text for normal chat and logging.
- When the scenario goal is met OR you've done enough (~${maxTurns} user turns), action=done with a short reason.
- You are on turn ${turnIndex + 1} of max ${maxTurns} (post-start). Don't ramble forever.
- The product speaks in calories (kcal). Rough estimates are fine.`;

  const messages = [
    { role: "system" as const, content: system },
    {
      role: "user" as const,
      content:
        `CURRENT BOT STATE:\n${formatSnapshot(snapshot)}\n\n` +
        `CONVERSATION SO FAR:\n${formatHistory(history) || "(just started)"}\n\n` +
        `What do you do next? Return one JSON action.`,
    },
  ];

  let parsed: {
    action: SimAction["action"];
    text: string | null;
    entry_id: number | null;
    kcal: number | null;
    command: "today" | "streak" | "undo" | "help" | "budget" | null;
    arg: string | null;
    reason: string | null;
  } | undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await chat({
        model: config.modelSimUser,
        maxTokens: 500,
        reasoning: false,
        jsonSchema: { name: "sim_action", schema: ACTION_SCHEMA },
        messages,
      });
      parsed = parseJsonLenient(raw);
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!parsed) throw lastErr;

  switch (parsed.action) {
    case "text":
      return { action: "text", text: parsed.text?.trim() || "ok" };
    case "correct":
      if (parsed.entry_id == null || parsed.kcal == null) {
        return { action: "text", text: parsed.text?.trim() || "that calorie estimate feels off" };
      }
      return { action: "correct", entry_id: parsed.entry_id, kcal: parsed.kcal };
    case "delete":
      if (parsed.entry_id == null) {
        return { action: "text", text: "nvm" };
      }
      return { action: "delete", entry_id: parsed.entry_id };
    case "command":
      if (!parsed.command) return { action: "command", command: "today" };
      return { action: "command", command: parsed.command, arg: parsed.arg ?? undefined };
    case "done":
      return { action: "done", reason: parsed.reason ?? "scenario complete" };
    default:
      return { action: "done", reason: "unknown action from sim" };
  }
}
