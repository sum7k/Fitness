import { config } from "../config.js";
import { debug } from "../log.js";

type ContentPart =
  | { type: "text"; text: string }
  | { type: "input_audio"; input_audio: { data: string; format: "mp3" | "wav" } }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

class TransientLlmError extends Error {}

export async function chat(opts: {
  model: string;
  messages: ChatMessage[];
  jsonSchema?: { name: string; schema: object };
  maxTokens?: number;
  /** Disable hidden thinking on reasoning models (Gemini 2.5, etc.) so content isn't empty. */
  reasoning?: false;
}): Promise<string> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    max_tokens: opts.maxTokens ?? 2000,
  };
  if (opts.jsonSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: opts.jsonSchema.name, strict: true, schema: opts.jsonSchema.schema },
    };
  }
  if (opts.reasoning === false) {
    body.reasoning = { enabled: false };
  }

  // Providers occasionally die mid-generation (200 + truncated content + zeroed
  // usage) or rate-limit; both are transient, so retry those and only those.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await chatOnce(opts, body);
    } catch (err) {
      if (!(err instanceof TransientLlmError)) throw err;
      lastErr = err;
      debug(`llm ${opts.model}: transient failure (attempt ${attempt}/3): ${err.message.slice(0, 200)}`);
    }
  }
  throw lastErr;
}

async function chatOnce(
  opts: { model: string; jsonSchema?: { name: string } },
  body: Record<string, unknown>,
): Promise<string> {
  const started = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openRouterApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const msg = `OpenRouter ${res.status}: ${(await res.text()).slice(0, 500)}`;
    if (res.status === 429 || res.status === 408 || res.status >= 500) {
      throw new TransientLlmError(msg);
    }
    throw new Error(msg);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string };
  };
  const finish = json.choices?.[0]?.finish_reason;
  debug(
    `llm ${opts.model}${opts.jsonSchema ? ` (${opts.jsonSchema.name})` : ""}: ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s, ` +
      `tokens ${json.usage?.prompt_tokens ?? "?"}→${json.usage?.completion_tokens ?? "?"}` +
      (finish && finish !== "stop" ? `, finish=${finish}` : ""),
  );
  if (json.error) {
    throw new TransientLlmError(`OpenRouter error field: ${JSON.stringify(json.error).slice(0, 300)}`);
  }
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new TransientLlmError(`OpenRouter empty response: ${JSON.stringify(json).slice(0, 500)}`);
  }
  if (finish && finish !== "stop") {
    // "error" = provider died mid-stream (retryable); "length" = truncated at
    // max_tokens — retry anyway, sampling variance usually fits on a second pass.
    throw new TransientLlmError(`OpenRouter finish_reason=${finish}, content likely truncated`);
  }
  return content;
}

// Models sometimes wrap JSON in markdown fences despite response_format.
export function parseJsonLenient<T>(raw: string): T {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(stripped) as T;
}
