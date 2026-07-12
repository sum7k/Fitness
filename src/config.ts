import "dotenv/config";

function required(name: string, ...aliases: string[]): string {
  for (const key of [name, ...aliases]) {
    const value = process.env[key];
    if (value) return value;
  }
  throw new Error(`Missing env var: ${name}`);
}

export const config = {
  // Optional for headless sim runs; createBot() still requires a real token.
  botToken: process.env.TELEGRAM_BOT_TOKEN ?? process.env.bot_token ?? "",
  openRouterApiKey: required("OPENROUTER_API_KEY"),
  // Extract stays on Gemini: it ingests voice-note audio natively, which no
  // Chinese model on OpenRouter currently does. Photos + text also flow through here.
  modelCheap: process.env.MODEL_CHEAP ?? "google/gemini-2.5-flash",
  // Buddy chat is text-only — swapped to DeepSeek-V3: ~10x cheaper than Sonnet.
  // Non-reasoning chat model, so no hidden-thinking tokens / empty-content risk.
  // (GLM-4.6 is a touch smarter but reasons by default — would need reasoning:{enabled:false}.)
  modelBuddy: process.env.MODEL_BUDDY ?? "deepseek/deepseek-chat",
  // SimUser should differ from buddy to avoid echo-chamber conversations.
  modelSimUser: process.env.MODEL_SIM_USER ?? "google/gemini-2.5-flash",
  dbPath: process.env.DB_PATH ?? "data/fitness.db",
  defaultTimezone: process.env.DEFAULT_TZ ?? "Asia/Kolkata",
  /** Shared invite code; rotate anytime. Empty = gate disabled (sim/dev only). */
  accessCode: (process.env.BOT_ACCESS_CODE ?? "").trim(),
};
