import { InlineKeyboard, type Context } from "grammy";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, dayLocal, normalizeName, type User } from "../db/index.js";
import { extract, type Extraction } from "../llm/extract.js";
import { applySizing } from "../domain/sizing.js";
import { computeTally, tallyLine } from "../domain/tally.js";
import { buddyReply } from "../llm/buddy.js";
import { SIZES, SIZE_KCAL_MID, type Size } from "../domain/sizes.js";
import { config } from "../config.js";
import { debug, error } from "../log.js";

const execFileAsync = promisify(execFile);

type InputPart = Parameters<typeof extract>[0][number];

export function entryKeyboard(entryId: number, current: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const [i, size] of SIZES.entries()) {
    kb.text(size === current ? `•${size}•` : size, `e:${entryId}:s:${size}`);
    if (i === 3) kb.row();
  }
  kb.text("🗑", `e:${entryId}:del`);
  return kb;
}

export function entryLine(kind: string, name: string, size: string, confidence: string | null): string {
  const icon = kind === "food" ? "🍽" : "🏃";
  const unsure = confidence === "low" ? " 🤔" : "";
  const suffix = kind === "exercise" ? " earned" : "";
  return `${icon} ${name} — ${size}${suffix}${unsure}`;
}

async function telegramFileToBase64(ctx: Context): Promise<string> {
  const file = await ctx.getFile();
  const url = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer()).toString("base64");
}

export async function voiceToParts(ctx: Context): Promise<InputPart[]> {
  const oggBase64 = await telegramFileToBase64(ctx);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const inPath = join(tmpdir(), `voice-${stamp}.oga`);
  const outPath = join(tmpdir(), `voice-${stamp}.mp3`);
  try {
    await writeFile(inPath, Buffer.from(oggBase64, "base64"));
    await execFileAsync("ffmpeg", ["-i", inPath, "-ac", "1", "-ar", "16000", "-y", outPath]);
    const mp3 = await readFile(outPath);
    debug(`voice transcoded: ${Math.round(oggBase64.length * 0.75 / 1024)}KB ogg → ${Math.round(mp3.length / 1024)}KB mp3`);
    return [{ type: "input_audio", input_audio: { data: mp3.toString("base64"), format: "mp3" } }];
  } finally {
    await rm(inPath, { force: true });
    await rm(outPath, { force: true });
  }
}

export async function photoToParts(ctx: Context): Promise<InputPart[]> {
  const base64 = await telegramFileToBase64(ctx);
  const parts: InputPart[] = [
    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } },
  ];
  const caption = ctx.message?.caption;
  if (caption) parts.unshift({ type: "text", text: `User's caption: ${caption}` });
  return parts;
}

export async function ingest(ctx: Context, user: User, parts: InputPart[], source: string) {
  await ctx.replyWithChatAction("typing");

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
    await ctx.reply("Couldn't process that one — try again?");
    return;
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
    await ctx.reply(`⚖️ ${extraction.weight_kg} kg noted.`);
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
    await ctx.reply(entryLine(entry.kind, entry.name, entry.size, entry.confidence), {
      reply_markup: entryKeyboard(entryId, entry.size),
    });
  }

  if (extraction.entries.length > 0) {
    await ctx.reply(tallyLine(computeTally(user)));
  }

  if ((extraction.intent === "chat" || extraction.intent === "mixed") && extraction.chat_text) {
    await ctx.replyWithChatAction("typing");
    try {
      const reply = await buddyReply(user, extraction.chat_text);
      debug(`buddy ⇨ "${reply.slice(0, 100)}${reply.length > 100 ? "…" : ""}"`);
      await ctx.reply(reply);
    } catch (err) {
      error("buddy failed:", err);
      await ctx.reply("Buddy's having a moment — ask me again in a bit.");
    }
  } else if (
    extraction.entries.length === 0 && !extraction.weight_kg && extraction.intent === "log"
  ) {
    await ctx.reply("Heard you, but couldn't find anything to log. Try naming the food or exercise.");
  }
}

export function kcalMidFor(size: string): number {
  return SIZE_KCAL_MID[size as Size] ?? 200;
}
