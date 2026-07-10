import { chat } from "./openrouter.js";
import { config } from "../config.js";
import { db, type User, dayLocal } from "../db/index.js";
import { computeTally, formatUnits, currentStreak, todayEntries } from "../domain/tally.js";

const BUDDY_SYSTEM_PROMPT = `You are the user's fitness buddy inside a Telegram logging bot. The bot tracks food and exercise in t-shirt sizes (XS≈50 kcal, S≈100, M≈200, L≈400, XL≈600, XXL≈800, XXXL≈1200+) instead of calorie counts, because rough-but-consistent beats precise-but-abandoned. 1 budget unit = one M.

Your character: warm, direct, grounded in the user's actual data. Like a knowledgeable friend, not a coach reading a script. Keep replies short — 2-5 sentences for most questions. This is Telegram chat, not an essay.

Ground every answer in the context data provided. Point at specifics ("your weekends run over budget") rather than generic advice. If the data can't answer their question, say so plainly.

Hard rules:
- No medical advice: no diagnosis, medication, supplement dosing, or injury treatment. Suggest a doctor/physio when it comes up.
- Watch for disordered-eating signals: requests for extreme restriction, punishment framing after eating, obsessive weight checking. Respond with care, never help optimize restriction, and if a pattern persists gently suggest talking to a professional.
- Never shame an over-budget day. It's information, not failure.
- Don't invent data you weren't given. Don't mention calories in numbers — speak in sizes and units.`;

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
    `- Goal: ${user.goal ?? "not set"} (${user.pace ?? "-"} pace), daily budget ${formatUnits(tally.budget)} units`,
    `- Exercise goal: ${user.exercise_goal_days ?? "not set"} day(s)/week; logged movement on ${weekExercise} of the last 7 days`,
    `- Eaten today: ${formatUnits(tally.foodUnits)} units, earned from exercise: ${formatUnits(tally.earnedUnits)}, remaining: ${formatUnits(tally.remaining)}`,
    `- Today's entries: ${entries.map((e) => `${e.name} (${e.kind}, ${e.size})`).join(", ") || "none yet"}`,
    `- Logging streak: ${streak} day(s)`,
    `- Recent weigh-ins (newest first): ${recentWeights.map((w) => `${w.weight_kg}kg on ${w.day_local}`).join(", ") || "none"}`,
    `- Last 14 days logging: ${last14.map((d) => `${d.day_local}: ${d.food_count}f/${d.exercise_count}e`).join("; ") || "none"}`,
  ].join("\n");

  const reply = await chat({
    model: config.modelBuddy,
    messages: [
      { role: "system", content: BUDDY_SYSTEM_PROMPT },
      { role: "system", content: `User data:\n${context}` },
      ...recentChat.map((m) => ({ role: m.role, content: m.text })),
      { role: "user", content: userMessage },
    ],
    maxTokens: 600,
  });

  const insertChat = db.prepare("INSERT INTO chat_log (user_id, role, text) VALUES (?, ?, ?)");
  insertChat.run(user.id, "user", userMessage);
  insertChat.run(user.id, "assistant", reply);
  db.prepare(
    "DELETE FROM chat_log WHERE user_id = ? AND id NOT IN (SELECT id FROM chat_log WHERE user_id = ? ORDER BY id DESC LIMIT 20)",
  ).run(user.id, user.id);

  return reply;
}
