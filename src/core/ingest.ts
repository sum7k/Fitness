import { db, dayLocal, normalizeName, type User } from "../db/index.js";
import { extract, type Extraction } from "../llm/extract.js";
import { applySizing } from "../domain/sizing.js";
import { computeTally, tallyLine } from "../domain/tally.js";
import { buddyReply } from "../llm/buddy.js";
import { SIZE_KCAL_MID, type Size } from "../domain/sizes.js";
import { debug, error } from "../log.js";
import type { BotTurn } from "./turns.js";

type InputPart = Parameters<typeof extract>[0][number];

export function entryLine(
  kind: string,
  name: string,
  size: string,
  confidence: string | null,
): string {
  const icon = kind === "food" ? "🍽" : "🏃";
  const unsure = confidence === "low" ? " 🤔" : "";
  const suffix = kind === "exercise" ? " earned" : "";
  return `${icon} ${name} — ${size}${suffix}${unsure}`;
}

export function kcalMidFor(size: string): number {
  return SIZE_KCAL_MID[size as Size] ?? 200;
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

  let extraction: Extraction;
  try {
    extraction = await extract(parts, localTime);
  } catch (err) {
    error("extraction failed:", err);
    return [{ text: "Couldn't process that one — try again?", kind: "error" }];
  }

  debug(`transcript (${source}): "${extraction.transcript}"`);
  debug(
    `extracted: intent=${extraction.intent}, ` +
      `entries=[${extraction.entries.map((e) => `${e.name}:${e.size}${e.confidence === "low" ? "?" : ""}`).join(", ")}], ` +
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

  const insert = db.prepare(
    `INSERT INTO entries (user_id, kind, name, name_normalized, size, kcal_estimate,
                          meal_slot, confidence, source, day_local)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const raw of extraction.entries) {
    const entry = applySizing(user, raw);
    if (entry.sizeSource !== "llm" || entry.size !== raw.size) {
      debug(`sizing "${raw.name}": ${raw.size} → ${entry.size} (${entry.sizeSource})`);
    }
    const result = insert.run(
      user.id, entry.kind, entry.name, normalizeName(entry.name), entry.size,
      entry.kcal_estimate, entry.meal_slot, entry.confidence, source, dayLocal(user.tz),
    );
    const entryId = Number(result.lastInsertRowid);
    turns.push({
      text: entryLine(entry.kind, entry.name, entry.size, entry.confidence),
      kind: "entry",
      entry: {
        id: entryId,
        kind: entry.kind,
        name: entry.name,
        size: entry.size,
        confidence: entry.confidence,
      },
    });
  }

  if (extraction.entries.length > 0) {
    // Refresh user in case weight was updated above
    const fresh = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as User;
    turns.push({ text: tallyLine(computeTally(fresh)), kind: "tally" });
  }

  if ((extraction.intent === "chat" || extraction.intent === "mixed") && extraction.chat_text) {
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
    extraction.entries.length === 0 && !extraction.weight_kg && extraction.intent === "log"
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
