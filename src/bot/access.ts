import type { Context, NextFunction } from "grammy";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { debug } from "../log.js";

const GATE_PROMPT = "Invite-only. Send the access code to continue.";
const GATE_OK = "You're in. Send /start to begin.";

export function isAllowed(tgUserId: number): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM allowed_users WHERE tg_user_id = ?")
    .get(tgUserId) as { ok: number } | undefined;
  return Boolean(row);
}

export function allowUser(tgUserId: number): void {
  db.prepare(
    "INSERT OR IGNORE INTO allowed_users (tg_user_id) VALUES (?)",
  ).run(tgUserId);
}

/** Exact match against the current env code (rotate by changing BOT_ACCESS_CODE). */
export function codeMatches(text: string): boolean {
  const code = config.accessCode;
  if (!code) return false;
  return text.trim() === code;
}

/**
 * Blocks every update from non-whitelisted users before handlers run —
 * no ingest, onboarding, or LLM. If the gate is disabled (empty code), pass through.
 */
export async function accessGate(ctx: Context, next: NextFunction): Promise<void> {
  if (!config.accessCode) {
    await next();
    return;
  }

  const tgId = ctx.from?.id;
  if (tgId == null) {
    await next();
    return;
  }

  if (isAllowed(tgId)) {
    await next();
    return;
  }

  const text = ctx.message?.text?.trim() ?? "";
  if (text && codeMatches(text)) {
    allowUser(tgId);
    debug(`access: whitelisted tg=${tgId}`);
    await ctx.reply(GATE_OK);
    return;
  }

  debug(`access: denied tg=${tgId}`);
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: "Invite-only.", show_alert: false });
    return;
  }
  // Only reply on messages — ignore other update types silently.
  if (ctx.message) {
    await ctx.reply(GATE_PROMPT);
  }
}
