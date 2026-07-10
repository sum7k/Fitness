import { chat, parseJsonLenient, type ChatMessage } from "./openrouter.js";
import { config } from "../config.js";

export interface ExtractedEntry {
  kind: "food" | "exercise";
  name: string;
  quantity_hint: string | null;
  kcal_estimate: number;
  size: "XS" | "S" | "M" | "L" | "XL" | "XXL" | "XXXL";
  confidence: "high" | "low";
  meal_slot: "breakfast" | "lunch" | "dinner" | "snack" | "unknown";
}

export interface Extraction {
  transcript: string;
  intent: "log" | "chat" | "weight" | "mixed";
  entries: ExtractedEntry[];
  weight_kg: number | null;
  chat_text: string | null;
}

const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    transcript: { type: "string" },
    intent: { type: "string", enum: ["log", "chat", "weight", "mixed"] },
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["food", "exercise"] },
          name: { type: "string" },
          quantity_hint: { type: ["string", "null"] },
          kcal_estimate: { type: "number" },
          size: { type: "string", enum: ["XS", "S", "M", "L", "XL", "XXL", "XXXL"] },
          confidence: { type: "string", enum: ["high", "low"] },
          meal_slot: {
            type: "string",
            enum: ["breakfast", "lunch", "dinner", "snack", "unknown"],
          },
        },
        required: [
          "kind", "name", "quantity_hint", "kcal_estimate",
          "size", "confidence", "meal_slot",
        ],
      },
    },
    weight_kg: { type: ["number", "null"] },
    chat_text: { type: ["string", "null"] },
  },
  required: ["transcript", "intent", "entries", "weight_kg", "chat_text"],
};

const SYSTEM_PROMPT = `You process input for a fitness logging bot. Input is text, a voice recording, or a food photo from one user. Extract what they ate, what exercise they did, any body-weight mention, and anything addressed to the bot as conversation.

SIZE SCALE (t-shirt sizes, anchored to rough kcal):
XS≈50, S≈100, M≈200, L≈400, XL≈600, XXL≈800, XXXL≈1200+
- Size the TOTAL quantity mentioned: 1 roti ≈ S, 2 rotis ≈ M. A bowl of dal ≈ M. Restaurant biryani plate ≈ L.
- When torn between two sizes: food rounds UP, exercise rounds DOWN.
- kcal_estimate is your honest rough estimate for the total quantity; size must be consistent with it.
- Exercise kcal: estimate for the stated duration/intensity assuming an average adult; walking casually ≈ 200-250 kcal/hour, jogging ≈ 500/hour, gym session ≈ 400-500/hour.

RULES:
- intent "log": only food/exercise/steps. "weight": only a weigh-in. "chat": a question or remark addressed to the bot. "mixed": log/weigh plus a question — fill both entries and chat_text.
- Whole-day narrations produce many entries; infer meal_slot from words like morning/lunch/evening, else "unknown".
- Steps count as exercise: "walked 8000 steps" → exercise "walking (8000 steps)", ≈ 280 kcal → M.
- Weigh-ins: "weighed 82", "82.4 kg today" → weight_kg. Never create an entry for it.
- Keep native/vernacular dish names as spoken (poha, dal, dosa, chai). Hinglish is common — transcribe faithfully.
- For photos: identify the dish(es) and portion from what is visible; confidence "low" unless obvious.
- confidence "low" whenever the item or portion is ambiguous.
- transcript: verbatim transcription for audio; for text input echo the text; for photos a one-line description.
- Non-food, non-fitness input with no question → intent "chat", chat_text = the input; entries empty.`;

type InputPart =
  | { type: "text"; text: string }
  | { type: "input_audio"; input_audio: { data: string; format: "mp3" | "wav" } }
  | { type: "image_url"; image_url: { url: string } };

export async function extract(parts: InputPart[], localTimeHint: string): Promise<Extraction> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: `User's local time: ${localTimeHint}` },
        ...parts,
      ],
    },
  ];
  const raw = await chat({
    model: config.modelCheap,
    messages,
    jsonSchema: { name: "extraction", schema: EXTRACTION_SCHEMA },
  });
  return parseJsonLenient<Extraction>(raw);
}
