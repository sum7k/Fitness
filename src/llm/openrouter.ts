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

export async function chat(opts: {
  model: string;
  messages: ChatMessage[];
  jsonSchema?: { name: string; schema: object };
  maxTokens?: number;
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
    throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string };
  };
  debug(
    `llm ${opts.model}${opts.jsonSchema ? ` (${opts.jsonSchema.name})` : ""}: ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s, ` +
      `tokens ${json.usage?.prompt_tokens ?? "?"}→${json.usage?.completion_tokens ?? "?"}`,
  );
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`OpenRouter empty response: ${JSON.stringify(json).slice(0, 500)}`);
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
