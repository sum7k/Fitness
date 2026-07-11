import { InlineKeyboard, type Context } from "grammy";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { User } from "../db/index.js";
import { extract } from "../llm/extract.js";
import { config } from "../config.js";
import { debug } from "../log.js";
import { ingestParts, entryLine } from "../core/ingest.js";
import type { BotTurn } from "../core/turns.js";

export { entryLine };

const execFileAsync = promisify(execFile);

type InputPart = Parameters<typeof extract>[0][number];

const KCAL_DELTAS = [-100, -50, 50, 100] as const;

export function entryKeyboard(entryId: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const d of KCAL_DELTAS) {
    const label = d > 0 ? `+${d}` : String(d);
    kb.text(label, `e:${entryId}:k:${d}`);
  }
  kb.text("🗑", `e:${entryId}:del`);
  return kb;
}

export async function replyTurns(ctx: Context, turns: BotTurn[]) {
  for (const t of turns) {
    if (t.entry) {
      await ctx.reply(t.text, {
        reply_markup: entryKeyboard(t.entry.id),
      });
    } else {
      await ctx.reply(t.text);
    }
  }
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
  const turns = await ingestParts(user, parts, source);
  await replyTurns(ctx, turns);
}
