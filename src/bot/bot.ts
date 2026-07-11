import { Bot } from "grammy";
import { config } from "../config.js";
import { db, getOrCreateUser, type Entry } from "../db/index.js";
import { startOnboarding, handleOnboarding } from "./onboarding.js";
import type { OnboardInputPart } from "../llm/onboard.js";
import { ingest, voiceToParts, photoToParts, entryKeyboard, replyTurns } from "./ingest.js";
import {
  cmdHelp, cmdToday, cmdStreak, cmdUndo, cmdBudget,
  adjustEntryKcal, deleteEntry,
} from "../core/commands.js";
import { debug, error } from "../log.js";

export function createBot(): Bot {
  if (!config.botToken) {
    throw new Error("Missing env var: TELEGRAM_BOT_TOKEN");
  }
  const bot = new Bot(config.botToken);

  bot.use(async (ctx, next) => {
    const m = ctx.message;
    const kind = m?.voice
      ? `voice (${m.voice.duration}s)`
      : m?.photo
        ? `photo${m.caption ? ` caption="${m.caption.slice(0, 60)}"` : ""}`
        : m?.text
          ? `text "${m.text.slice(0, 80)}"`
          : ctx.callbackQuery
            ? `callback ${ctx.callbackQuery.data}`
            : "other update";
    debug(`⇦ from ${ctx.from?.id}: ${kind}`);
    await next();
  });

  bot.command("start", async (ctx) => {
    const user = getOrCreateUser(ctx.from!.id);
    await startOnboarding(ctx, user);
  });

  bot.command("help", async (ctx) => {
    await replyTurns(ctx, cmdHelp());
  });

  bot.command("today", async (ctx) => {
    await replyTurns(ctx, cmdToday(getOrCreateUser(ctx.from!.id)));
  });

  bot.command("streak", async (ctx) => {
    await replyTurns(ctx, cmdStreak(getOrCreateUser(ctx.from!.id)));
  });

  bot.command("undo", async (ctx) => {
    await replyTurns(ctx, cmdUndo(getOrCreateUser(ctx.from!.id)));
  });

  bot.command("budget", async (ctx) => {
    const arg = ctx.match?.toString().trim() ?? "";
    await replyTurns(ctx, cmdBudget(getOrCreateUser(ctx.from!.id), arg));
  });

  bot.on("message:text", async (ctx) => {
    const user = getOrCreateUser(ctx.from.id);
    if (user.onboarding_state === "chat") {
      await handleOnboarding(ctx, user, [{ type: "text", text: ctx.message.text }]);
      return;
    }
    await ingest(ctx, user, [{ type: "text", text: ctx.message.text }], "text");
  });

  bot.on("message:voice", async (ctx) => {
    const user = getOrCreateUser(ctx.from.id);
    if (user.onboarding_state === "chat") {
      try {
        await handleOnboarding(ctx, user, (await voiceToParts(ctx)) as OnboardInputPart[]);
      } catch (err) {
        error("voice onboarding failed:", err);
        await ctx.reply("Couldn't hear that one — try again?");
      }
      return;
    }
    try {
      await ingest(ctx, user, await voiceToParts(ctx), "voice");
    } catch (err) {
      error("voice processing failed:", err);
      await ctx.reply("Couldn't process that voice note — try again?");
    }
  });

  bot.on("message:photo", async (ctx) => {
    const user = getOrCreateUser(ctx.from.id);
    if (user.onboarding_state === "chat") {
      await ctx.reply("Let's finish setup first — just tell me about yourself in a message or voice note.");
      return;
    }
    try {
      await ingest(ctx, user, await photoToParts(ctx), "photo");
    } catch (err) {
      error("photo processing failed:", err);
      await ctx.reply("Couldn't process that photo — try again?");
    }
  });

  bot.on("callback_query:data", async (ctx) => {
    const user = getOrCreateUser(ctx.from.id);
    const data = ctx.callbackQuery.data;

    const match = data.match(/^e:(\d+):(k:(-?\d+)|del)$/);
    if (!match) {
      await ctx.answerCallbackQuery();
      return;
    }
    const entryId = Number(match[1]);
    const entry = db
      .prepare("SELECT * FROM entries WHERE id = ? AND user_id = ?")
      .get(entryId, user.id) as Entry | undefined;
    if (!entry) {
      await ctx.answerCallbackQuery({ text: "Entry no longer exists." });
      return;
    }

    if (match[2] === "del") {
      const turns = deleteEntry(user, entryId);
      await ctx.editMessageText(turns[0]?.text.split("\n")[0] ?? `❌ ${entry.name} — removed`);
      await ctx.answerCallbackQuery({ text: turns[0]?.text.split("\n").slice(1).join(" ") || "removed" });
      return;
    }

    const delta = Number(match[3]);
    const turns = adjustEntryKcal(user, entryId, delta);
    const entryTurn = turns.find((t) => t.entry);
    if (entryTurn?.entry) {
      await ctx.editMessageText(entryTurn.text, {
        reply_markup: entryKeyboard(entryTurn.entry.id),
      });
    }
    const note = turns.find((t) => t.kind === "system");
    await ctx.answerCallbackQuery({ text: note?.text ?? "updated" });
  });

  bot.catch((err) => {
    error("bot error:", err.error);
  });

  return bot;
}
