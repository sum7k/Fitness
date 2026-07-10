import { Bot, type Context } from "grammy";
import { config } from "../config.js";
import { db, getOrCreateUser, dayLocal, type Entry } from "../db/index.js";
import { startOnboarding, handleOnboarding } from "./onboarding.js";
import type { OnboardInputPart } from "../llm/onboard.js";
import { ingest, voiceToParts, photoToParts, entryKeyboard, entryLine, kcalMidFor } from "./ingest.js";
import { saveOverride } from "../domain/sizing.js";
import { computeTally, tallyLine, formatUnits, currentStreak, todayEntries } from "../domain/tally.js";
import { isSize } from "../domain/sizes.js";
import {
  baseEnergy, safeFloorKcal, parseBudgetArg, unitsToKcal, hasEnergyProfile,
  type Sex, type Activity,
} from "../domain/energy.js";
import { debug, error } from "../log.js";

export function createBot(): Bot {
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
    await ctx.reply(
      "Talk to me like a friend:\n" +
        '🎤 "had poha and chai" — logs food\n' +
        '🎤 "ran 5k this morning" — logs exercise\n' +
        '🎤 "weighed 81.5" — logs weight\n' +
        "📷 photo of your plate — I'll size it\n" +
        '💬 "why am I not losing weight?" — I\'ll look at your data\n\n' +
        "Narrate a whole day at once, that works too.\n\n" +
        "/today — today's log and budget\n/budget — view or set your daily target\n/streak — logging streak\n/undo — remove last entry",
    );
  });

  bot.command("today", async (ctx) => {
    const user = getOrCreateUser(ctx.from!.id);
    const entries = todayEntries(user);
    if (entries.length === 0) {
      await ctx.reply("Nothing logged today yet. Tell me what you've eaten.");
      return;
    }
    const lines = entries.map((e) => entryLine(e.kind, e.name, e.size, null));
    await ctx.reply(`${lines.join("\n")}\n\n${tallyLine(computeTally(user))}`);
  });

  bot.command("streak", async (ctx) => {
    const user = getOrCreateUser(ctx.from!.id);
    const streak = currentStreak(user);
    await ctx.reply(
      streak === 0
        ? "No streak yet — log one thing today and it starts."
        : `🔥 ${streak} day${streak === 1 ? "" : "s"} logging streak. Showing up is the whole game.`,
    );
  });

  bot.command("undo", async (ctx) => {
    const user = getOrCreateUser(ctx.from!.id);
    const last = db
      .prepare("SELECT * FROM entries WHERE user_id = ? AND day_local = ? ORDER BY id DESC LIMIT 1")
      .get(user.id, dayLocal(user.tz)) as Entry | undefined;
    if (!last) {
      await ctx.reply("Nothing to undo today.");
      return;
    }
    db.prepare("DELETE FROM entries WHERE id = ?").run(last.id);
    await ctx.reply(`Removed: ${last.name} (${last.size}).\n${tallyLine(computeTally(user))}`);
  });

  bot.command("budget", async (ctx) => {
    const user = getOrCreateUser(ctx.from!.id);
    const arg = ctx.match?.toString().trim() ?? "";

    // Compute the user's energy picture if we have a full profile.
    const energy = hasEnergyProfile(user)
      ? baseEnergy({
          weight_kg: user.weight_kg!,
          height_cm: user.height_cm!,
          age: user.age!,
          sex: user.sex as Sex,
          activity: user.activity as Activity,
        })
      : null;
    const floor = user.sex ? safeFloorKcal(user.sex as Sex) : null;

    if (!arg) {
      if (user.daily_budget_units == null) {
        await ctx.reply("No budget set yet — run /start to set one up.");
        return;
      }
      const lines = [
        `Daily budget: ~${formatUnits(user.daily_budget_units)} M (≈ ${unitsToKcal(user.daily_budget_units)} kcal). Exercise earns more back.`,
      ];
      if (energy) {
        lines.push(`Your maintenance ≈ ${energy.tdee} kcal/day; resting burn ≈ ${energy.bmr} kcal.`);
      }
      lines.push("Set your own: /budget 1900  (calories) or /budget 10M (sizes).");
      await ctx.reply(lines.join("\n\n"));
      return;
    }

    const parsed = parseBudgetArg(arg);
    if (!parsed) {
      await ctx.reply("Try: /budget 1900  (calories) or /budget 10M (sizes).");
      return;
    }
    db.prepare("UPDATE users SET daily_budget_units = ? WHERE id = ?").run(parsed.units, user.id);

    let msg = `Budget set: ~${formatUnits(parsed.units)} M (≈ ${unitsToKcal(parsed.units)} kcal/day). Exercise earns more back.`;
    if (floor && unitsToKcal(parsed.units) < floor) {
      msg += `\n\nHeads up: that's below a safe daily minimum (~${floor} kcal). Fine short-term, but hard to sustain — nudge it up if you feel wiped.`;
    }
    await ctx.reply(msg);
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

    const match = data.match(/^e:(\d+):(s:(\w+)|del)$/);
    if (!match) {
      await ctx.answerCallbackQuery();
      return;
    }
    const entry = db
      .prepare("SELECT * FROM entries WHERE id = ? AND user_id = ?")
      .get(Number(match[1]), user.id) as Entry | undefined;
    if (!entry) {
      await ctx.answerCallbackQuery({ text: "Entry no longer exists." });
      return;
    }

    if (match[2] === "del") {
      db.prepare("DELETE FROM entries WHERE id = ?").run(entry.id);
      await ctx.editMessageText(`❌ ${entry.name} — removed`);
      await ctx.answerCallbackQuery({ text: tallyLine(computeTally(user)) });
      return;
    }

    const newSize = match[3];
    if (!isSize(newSize)) {
      await ctx.answerCallbackQuery();
      return;
    }
    db.prepare("UPDATE entries SET size = ?, kcal_estimate = ? WHERE id = ?").run(
      newSize, kcalMidFor(newSize), entry.id,
    );
    saveOverride(user.id, entry.name, newSize, kcalMidFor(newSize));
    await ctx.editMessageText(entryLine(entry.kind, entry.name, newSize, null), {
      reply_markup: entryKeyboard(entry.id, newSize),
    });
    await ctx.answerCallbackQuery({
      text: `${entry.name} = ${newSize}, remembered. ${formatUnits(computeTally(user).remaining)} M left.`,
    });
  });

  bot.catch((err) => {
    error("bot error:", err.error);
  });

  return bot;
}
