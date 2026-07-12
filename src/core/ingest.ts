import { db, dayLocal, normalizeName, type Entry, type User } from "../db/index.js";
import { extract, type Extraction } from "../llm/extract.js";
import { resolveKcal, enrichFromWeb, saveOverride } from "../domain/kcal.js";
import { computeTally, tallyLine, todayEntries, entryKcal, formatKcal } from "../domain/tally.js";
import { buddyReply } from "../llm/buddy.js";
import { debug, error } from "../log.js";
import type { BotTurn } from "./turns.js";

type InputPart = Parameters<typeof extract>[0][number];

export function entryLine(
  kind: string,
  name: string,
  kcal: number,
  confidence: string | null,
): string {
  const icon = kind === "food" ? "🍽" : "🏃";
  const unsure = confidence === "low" ? " 🤔" : "";
  const suffix = kind === "exercise" ? " earned" : "";
  return `${icon} ${name} — ~${formatKcal(kcal)} kcal${suffix}${unsure}`;
}

/** Match a spoken correction name to today's most recent matching entry. */
function matchTodayEntry(user: User, name: string): Entry | undefined {
  const key = normalizeName(name);
  const entries = todayEntries(user);
  const exact = entries.filter((e) => normalizeName(e.name) === key);
  if (exact.length) return exact[exact.length - 1];
  const loose = entries.filter((e) => {
    const n = normalizeName(e.name);
    return n.includes(key) || key.includes(n);
  });
  return loose.length ? loose[loose.length - 1] : undefined;
}

function applyCorrection(user: User, entry: Entry, kcal: number): BotTurn[] {
  const next = Math.max(10, Math.round(kcal));
  db.prepare("UPDATE entries SET kcal_estimate = ? WHERE id = ?").run(next, entry.id);
  saveOverride(user.id, entry.name, next);
  const fresh = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as User;
  return [{
    kind: "entry",
    text: entryLine(entry.kind, entry.name, next, null),
    entry: {
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      kcal: next,
      confidence: null,
    },
  }, {
    kind: "system",
    text: `${entry.name} = ~${formatKcal(next)} kcal, remembered. ${formatKcal(computeTally(fresh).remainingKcal)} kcal left.`,
  }];
}

export async function ingestParts(
  user: User,
  parts: InputPart[],
  source: string,
): Promise<BotTurn[]> {
  const turns: BotTurn[] = [];
  const localTime = new Date().toLocaleString("en-IN", {
    timeZone: user.tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const loggedToday = todayEntries(user).map(
    (e) => `${e.name} (~${entryKcal(e)} kcal)`,
  );

  let extraction: Extraction;
  try {
    extraction = await extract(parts, localTime, loggedToday);
  } catch (err) {
    error("extraction failed:", err);
    return [{ text: "Couldn't process that one — try again?", kind: "error" }];
  }

  debug(`transcript (${source}): "${extraction.transcript}"`);
  debug(
    `extracted: intent=${extraction.intent}, ` +
      `entries=[${extraction.entries.map((e) => `${e.name}:${e.kcal_estimate}kcal${e.confidence === "low" ? "?" : ""}`).join(", ")}], ` +
      `corrections=[${extraction.corrections.map((c) => `${c.name}:${c.kcal_estimate}`).join(", ")}], ` +
      `weight=${extraction.weight_kg ?? "-"}, chat=${extraction.chat_text ? `"${extraction.chat_text.slice(0, 60)}"` : "-"}`,
  );

  if (extraction.weight_kg) {
    db.prepare("INSERT INTO weights (user_id, weight_kg, day_local) VALUES (?, ?, ?)").run(
      user.id, extraction.weight_kg, dayLocal(user.tz),
    );
    db.prepare("UPDATE users SET weight_kg = ? WHERE id = ?").run(extraction.weight_kg, user.id);
    debug(`weight recorded: ${extraction.weight_kg}kg for user ${user.id}`);
    turns.push({ text: `⚖️ ${extraction.weight_kg} kg noted.`, kind: "weight" });
  }

  let corrected = 0;
  for (const corr of extraction.corrections) {
    const target = matchTodayEntry(user, corr.name);
    if (!target) {
      debug(`correction miss: "${corr.name}" → ${corr.kcal_estimate}`);
      continue;
    }
    debug(`correction "${corr.name}" → entry ${target.id} ~${corr.kcal_estimate} kcal`);
    turns.push(...applyCorrection(user, target, corr.kcal_estimate));
    corrected++;
  }

  const insert = db.prepare(
    `INSERT INTO entries (user_id, kind, name, name_normalized, kcal_estimate,
                          meal_slot, confidence, source, day_local)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Resolve locally first, then web-enrich low-confidence foods in parallel.
  const resolved = await Promise.all(
    extraction.entries.map(async (raw) => {
      const base = resolveKcal(user, raw);
      const entry = await enrichFromWeb(base);
      if (entry.kcalSource !== "llm") {
        debug(`kcal "${raw.name}": ${raw.kcal_estimate} → ${entry.kcal_estimate} (${entry.kcalSource})`);
      }
      return entry;
    }),
  );

  for (const entry of resolved) {
    const result = insert.run(
      user.id, entry.kind, entry.name, normalizeName(entry.name), entry.kcal_estimate,
      entry.meal_slot, entry.confidence, source, dayLocal(user.tz),
    );
    const entryId = Number(result.lastInsertRowid);
    const kcal = Math.round(entry.kcal_estimate);
    turns.push({
      text: entryLine(entry.kind, entry.name, kcal, entry.confidence),
      kind: "entry",
      entry: {
        id: entryId,
        kind: entry.kind,
        name: entry.name,
        kcal,
        confidence: entry.confidence,
      },
    });
  }

  if (extraction.entries.length > 0) {
    const fresh = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as User;
    turns.push({ text: tallyLine(computeTally(fresh)), kind: "tally" });
  }

  // Spoken corrections already get a confirmation turn; skip buddy when that was the whole ask.
  const chatOnlyCorrection =
    corrected > 0 &&
    extraction.entries.length === 0 &&
    !extraction.weight_kg &&
    (extraction.intent === "chat" || extraction.intent === "mixed");

  if (
    (extraction.intent === "chat" || extraction.intent === "mixed") &&
    extraction.chat_text &&
    !chatOnlyCorrection
  ) {
    try {
      const fresh = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as User;
      const reply = await buddyReply(fresh, extraction.chat_text);
      debug(`buddy ⇨ "${reply.slice(0, 100)}${reply.length > 100 ? "…" : ""}"`);
      turns.push({ text: reply, kind: "buddy" });
    } catch (err) {
      error("buddy failed:", err);
      turns.push({ text: "Buddy's having a moment — ask me again in a bit.", kind: "error" });
    }
  } else if (
    extraction.entries.length === 0 &&
    !extraction.weight_kg &&
    corrected === 0 &&
    extraction.intent === "log"
  ) {
    turns.push({
      text: "Heard you, but couldn't find anything to log. Try naming the food or exercise.",
      kind: "system",
    });
  }

  return turns;
}

export async function ingestText(user: User, text: string): Promise<BotTurn[]> {
  return ingestParts(user, [{ type: "text", text }], "text");
}
