import { chat } from "./openrouter.js";
import { config } from "../config.js";
import { db, type User, dayLocal } from "../db/index.js";
import { computeTally, formatKcal, currentStreak, todayEntries, entryKcal } from "../domain/tally.js";

const BUDDY_SYSTEM_PROMPT = `You are the user's fitness buddy inside a Telegram logging bot. The bot tracks food and exercise with rough calorie estimates — not lab-precise, just good enough to stay consistent. Exercise credit is deliberately damped (about half of estimated burn).

Your character: warm, direct, grounded in the user's actual data. Like a knowledgeable friend, not a coach reading a script. Keep replies short — 2-5 sentences for most questions. This is Telegram chat, not an essay.

Ground every answer in the context data provided. Point at specifics ("your weekends run over budget") rather than generic advice. If the data can't answer their question, say so plainly.

Hard rules:
- PLAIN TEXT ONLY. Telegram shows your reply verbatim: no markdown (**bold**, *italics*, # headers, bullet/numbered list syntax), no roleplay stage directions like *grins*. Asterisks appear literally to the user.
- NUMBERS: the "User data" block is the ONLY source of truth for budget, eaten, earned, remaining, streak, and weights. Earlier chat messages may contain stale or wrong numbers — ignore them. Never do your own calorie arithmetic; quote the provided numbers exactly or don't cite numbers at all.
- Speak in calories (kcal). Estimates are rough — say "about" / "~" when helpful.
- YOU CANNOT EDIT DATA. You can't change entry calories, add or delete entries, or change the budget. Estimate wrong → tell them to tap the +/- buttons under that entry. Remove last → /undo. Budget → /budget. Never claim you updated, adjusted, or logged anything.
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

export async function buddyReply(user: User, userMessage: string): Promise<string> {
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
    `- Today's entries: ${entries.map((e) => `${e.name} (${e.kind}, ~${entryKcal(e)} kcal)`).join(", ") || "none yet"}`,
    `- Logging streak: ${streak} day(s)`,
    `- Recent weigh-ins (newest first): ${recentWeights.map((w) => `${w.weight_kg}kg on ${w.day_local}`).join(", ") || "none"}`,
    `- Last 14 days logging: ${last14.map((d) => `${d.day_local}: ${d.food_count}f/${d.exercise_count}e`).join("; ") || "none"}`,
  ].join("\n");

  const reply = stripMarkdown(await chat({
    model: config.modelBuddy,
    messages: [
      { role: "system", content: BUDDY_SYSTEM_PROMPT },
      { role: "system", content: `User data:\n${context}` },
      ...recentChat.map((m) => ({ role: m.role, content: m.text })),
      { role: "user", content: userMessage },
    ],
    maxTokens: 600,
  }));

  const insertChat = db.prepare("INSERT INTO chat_log (user_id, role, text) VALUES (?, ?, ?)");
  insertChat.run(user.id, "user", userMessage);
  insertChat.run(user.id, "assistant", reply);
  db.prepare(
    "DELETE FROM chat_log WHERE user_id = ? AND id NOT IN (SELECT id FROM chat_log WHERE user_id = ? ORDER BY id DESC LIMIT 20)",
  ).run(user.id, user.id);

  return reply;
}
