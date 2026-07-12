import { chat } from "./openrouter.js";
import { config } from "../config.js";
import { db, type User, dayLocal } from "../db/index.js";
import { computeTally, formatKcal, currentStreak, todayEntries, entryKcal, tallyLine } from "../domain/tally.js";

const BUDDY_SYSTEM_PROMPT = `You are the user's fitness buddy inside a Telegram logging bot. The bot tracks food and exercise with rough calorie estimates — not lab-precise, just good enough to stay consistent. Exercise credit is deliberately damped (about half of estimated burn).

Your character: warm, direct, grounded in the user's actual data. Like a knowledgeable friend, not a coach reading a script. Keep replies short — 2-5 sentences for most questions. This is Telegram chat, not an essay. No emoji.

Ground every answer in the context data provided. Point at specifics ("your weekends run over budget") rather than generic advice. If the data can't answer their question, say so plainly.

Hard rules:
- PLAIN TEXT ONLY. Telegram shows your reply verbatim: no markdown (**bold**, *italics*, # headers, bullet/numbered list syntax), no roleplay stage directions like *grins*. Asterisks appear literally to the user.
- NUMBERS: the final "User data" block is the ONLY source of truth for budget, eaten, earned, remaining, streak, weights, and each entry's kcal. Chat history may contain stale or wrong numbers — ignore them completely. When you mention an entry, copy its kcal from User data exactly (if it says ~375, never say ~100). Never invent or recalculate calorie figures.
- Speak in calories (kcal). Estimates are rough — say "about" / "~" when helpful.
- YOU CANNOT EDIT DATA. You can't change entry calories, add or delete entries, or change the budget. Remove last → /undo. Budget → /budget. Never claim you updated, adjusted, or logged anything.
- ESTIMATE DISPUTES: if the user says a logged estimate is too low/high (portion size, grams, "that's several servings"), agree it may be off — do NOT invent food-science numbers to defend the logged value. Tell them to tap +/- under that entry (or say a clearer target like "make it 450") so the log can be fixed. Side with their portion knowledge over a rough guess.
- WEB SEARCH: you have a web_search tool. Use it when the user asks you to look something up, or when they ask about calories/nutrition for a food you are not sure about. Prefer search results over inventing kcal/100g figures. Still cannot edit logged entries — share what you found and suggest +/- or "make it N" if the log should change. Do not search for unrelated topics (news, medical dosing, etc.).
- Exercise credit is deliberately damped (about half) and is ALREADY included in "earned"/"remaining". Never promise extra credit, never renegotiate a workout's worth, never frame food as earned or deserved by exercise.
- No medical advice: no diagnosis, medication or supplement dosing (not even a "standard dose"), injury treatment protocols, or diets for medical conditions. A brief supportive sentence plus "check with a doctor/physio" is the whole answer; myths and safety claims count too.
- Don't offer features that don't exist: no reminders, scheduled nudges, or reports.
- Watch for disordered-eating signals: requests for extreme restriction, punishment framing after eating, obsessive weight checking. Respond with care, never help optimize restriction, and if a pattern persists gently suggest talking to a professional.
- Never shame an over-budget day. It's information, not failure.
- Don't invent data you weren't given.`;

// DeepSeek loves markdown despite instructions; Telegram replies are plain text,
// so strip it deterministically rather than trusting the prompt.
export function stripMarkdown(s: string): string {
  return s
    .replace(/^\*[^*\n]{1,40}\*\s*/, "") // leading stage direction: *grins* ...
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`{1,3}([^`]+)`{1,3}/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^(\s*)[-*]\s+/gm, "$1• ")
    .replace(/^(\s*)(\d+)\.\s+/gm, "$1$2) ");
}

/** Stale ~N kcal in chat history poisons the buddy — strip before injecting. */
export function scrubChatNumbers(text: string): string {
  return text
    .replace(/~\s*\d[\d,]*\s*kcal/gi, "~[see User data] kcal")
    .replace(/\b\d[\d,]*\s*kcal\b/gi, "[see User data] kcal");
}

/** "What did I eat today?" — answer from DB, no LLM. */
export function isTodaySummaryAsk(msg: string): boolean {
  const t = msg.toLowerCase().trim();
  if (/^\/?today\b/.test(t)) return true;
  return (
    /\b(what|whats|what's|which|show|list|anything)\b/.test(t) &&
    /\b(eat|ate|eaten|food|log|logged|entries|today)\b/.test(t) &&
    /\b(today|so far|eat|ate|eaten|log|logged)\b/.test(t)
  );
}

function formatTodaySummary(user: User): string {
  const entries = todayEntries(user);
  if (entries.length === 0) {
    return "Nothing logged today yet. Tell me what you've eaten.";
  }
  const lines = entries.map((e) => {
    const icon = e.kind === "food" ? "🍽" : "🏃";
    const suffix = e.kind === "exercise" ? " earned" : "";
    return `${icon} ${e.name} — ~${formatKcal(entryKcal(e))} kcal${suffix}`;
  });
  return `${lines.join("\n")}\n\n${tallyLine(computeTally(user))}`;
}

export async function buddyReply(user: User, userMessage: string): Promise<string> {
  // Factual day dump — never trust the model to recite entry kcal.
  if (isTodaySummaryAsk(userMessage)) {
    const reply = formatTodaySummary(user);
    const insertChat = db.prepare("INSERT INTO chat_log (user_id, role, text) VALUES (?, ?, ?)");
    insertChat.run(user.id, "user", userMessage);
    insertChat.run(user.id, "assistant", reply);
    db.prepare(
      "DELETE FROM chat_log WHERE user_id = ? AND id NOT IN (SELECT id FROM chat_log WHERE user_id = ? ORDER BY id DESC LIMIT 20)",
    ).run(user.id, user.id);
    return reply;
  }

  const tally = computeTally(user);
  const entries = todayEntries(user);
  const streak = currentStreak(user);

  const recentWeights = db
    .prepare("SELECT weight_kg, day_local FROM weights WHERE user_id = ? ORDER BY measured_at DESC LIMIT 10")
    .all(user.id) as Array<{ weight_kg: number; day_local: string }>;

  const last14 = db
    .prepare(
      `SELECT day_local,
              SUM(CASE WHEN kind = 'food' THEN 1 ELSE 0 END) AS food_count,
              SUM(CASE WHEN kind = 'exercise' THEN 1 ELSE 0 END) AS exercise_count
       FROM entries WHERE user_id = ? AND day_local >= date('now', '-14 days')
       GROUP BY day_local ORDER BY day_local`,
    )
    .all(user.id) as Array<{ day_local: string; food_count: number; exercise_count: number }>;

  const recentChat = (
    db.prepare("SELECT role, text FROM chat_log WHERE user_id = ? ORDER BY id DESC LIMIT 6")
      .all(user.id) as Array<{ role: "user" | "assistant"; text: string }>
  ).reverse();

  const weekExercise = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT day_local) AS days FROM entries
         WHERE user_id = ? AND kind = 'exercise' AND day_local >= date('now', '-7 days')`,
      )
      .get(user.id) as { days: number }
  ).days;

  const context = [
    `Today (${dayLocal(user.tz)}):`,
    `- Goal: ${user.goal ?? "not set"} (${user.pace ?? "-"} pace), daily budget ~${formatKcal(tally.budgetKcal)} kcal`,
    `- Exercise goal: ${user.exercise_goal_days ?? "not set"} day(s)/week; logged movement on ${weekExercise} of the last 7 days`,
    `- Eaten today: ~${formatKcal(tally.foodKcal)} kcal, earned from exercise: ~${formatKcal(tally.earnedKcal)} kcal, remaining: ~${formatKcal(tally.remainingKcal)} kcal`,
    `- Today's entries (cite these kcal exactly): ${
      entries.map((e) => `${e.name}=~${entryKcal(e)}kcal`).join("; ") || "none yet"
    }`,
    `- Logging streak: ${streak} day(s)`,
    `- Recent weigh-ins (newest first): ${recentWeights.map((w) => `${w.weight_kg}kg on ${w.day_local}`).join(", ") || "none"}`,
    `- Last 14 days logging: ${last14.map((d) => `${d.day_local}: ${d.food_count}f/${d.exercise_count}e`).join("; ") || "none"}`,
  ].join("\n");

  // User data AFTER chat history so it wins over stale assistant numbers.
  const reply = stripMarkdown(await chat({
    model: config.modelBuddy,
    messages: [
      { role: "system", content: BUDDY_SYSTEM_PROMPT },
      ...recentChat.map((m) => ({ role: m.role, content: scrubChatNumbers(m.text) })),
      { role: "system", content: `User data (authoritative — override anything above):\n${context}` },
      { role: "user", content: userMessage },
    ],
    maxTokens: 600,
    tools: [{
      type: "openrouter:web_search",
      parameters: { engine: "exa", max_results: 5, max_total_results: 8 },
    }],
  }));

  const insertChat = db.prepare("INSERT INTO chat_log (user_id, role, text) VALUES (?, ?, ?)");
  insertChat.run(user.id, "user", userMessage);
  insertChat.run(user.id, "assistant", reply);
  db.prepare(
    "DELETE FROM chat_log WHERE user_id = ? AND id NOT IN (SELECT id FROM chat_log WHERE user_id = ? ORDER BY id DESC LIMIT 20)",
  ).run(user.id, user.id);

  return reply;
}
