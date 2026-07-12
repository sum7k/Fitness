import { chat, parseJsonLenient, type ChatMessage } from "./openrouter.js";
import { config } from "../config.js";

export interface ExtractedEntry {
  kind: "food" | "exercise";
  name: string;
  quantity_hint: string | null;
  kcal_estimate: number;
  confidence: "high" | "low";
  meal_slot: "breakfast" | "lunch" | "dinner" | "snack" | "unknown";
}

export interface ExtractedCorrection {
  name: string;
  kcal_estimate: number;
}

export interface Extraction {
  transcript: string;
  intent: "log" | "chat" | "weight" | "mixed";
  entries: ExtractedEntry[];
  corrections: ExtractedCorrection[];
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
          confidence: { type: "string", enum: ["high", "low"] },
          meal_slot: {
            type: "string",
            enum: ["breakfast", "lunch", "dinner", "snack", "unknown"],
          },
        },
        required: [
          "kind", "name", "quantity_hint", "kcal_estimate",
          "confidence", "meal_slot",
        ],
      },
    },
    corrections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          kcal_estimate: { type: "number" },
        },
        required: ["name", "kcal_estimate"],
      },
    },
    weight_kg: { type: ["number", "null"] },
    chat_text: { type: ["string", "null"] },
  },
  required: ["transcript", "intent", "entries", "corrections", "weight_kg", "chat_text"],
};

const SYSTEM_PROMPT = `You process input for a fitness logging bot. Input is text, a voice recording, or a food photo from one user. Extract what they ate, what exercise they did, any body-weight mention, and anything addressed to the bot as conversation.

CALORIES:
- kcal_estimate is a rough honest estimate for the TOTAL quantity mentioned (1 roti ≈ 100, 2 rotis ≈ 200, bowl of dal ≈ 200, restaurant biryani plate ≈ 600–800).
- WEIGHT/VOLUME SCALING: when the user gives grams, ml, or "100g of X", estimate for THAT mass — never treat grams as "one serving". Use ≈kcal per 100g × (grams/100). Examples: plain murmura/puffed rice ≈ 350–400 kcal/100g; jhal muri / bhel with oil/peanuts ≈ 400–500 kcal/100g; peanuts ≈ 560/100g; cooked rice ≈ 130/100g; milk ≈ 60–70/100ml. So "jhal muri 100 gm" ≈ 400–500, NOT ≈ 100.
- A street "serving" of light snacks is often 20–40g. If they say 100g of a light snack, that is several servings — scale up.
- Round to a sensible number (nearest 10–25 is fine). Prefer slightly high for food, slightly low for exercise when unsure.
- Exercise kcal: estimate for the stated duration/intensity assuming an average adult; walking casually ≈ 200-250 kcal/hour, jogging ≈ 500/hour, gym session ≈ 400-500/hour.

RULES:
- intent "log": only food/exercise/steps. "weight": only a weigh-in. "chat": a question or remark addressed to the bot. "mixed": log/weigh plus a question — fill both entries and chat_text.
- ONE ENTRY PER FOOD: split combined mentions — "2 roti, sabzi aur dal" → three entries (roti, sabzi, dal). Never produce an entry name that joins foods with "and"/commas/"with" ("dal roti sabzi", "chai with namkeen" are wrong). Keep a single entry only for a genuinely single named dish (idli sambar, chole bhature, pav bhaji).
- ALREADY LOGGED TODAY: the user message may include a list of items already logged today. If the user refers to one of those again — correcting calories ("that biryani was more like 800", "100g is easily 4–5 servings so ~450"), saying it was bigger/smaller, clarifying quantity of a logged item, mentioning it in passing ("before the dal"), or asking about it — that is intent "chat" (put the remark in chat_text), NOT a new entry. Only log genuinely new eating/exercise events.
- CORRECTIONS: when the user clearly wants a different calorie total for an already-logged item, add one object to corrections with that item's name (match the logged name) and the absolute kcal_estimate they imply. Examples: "make it 400", "more like 800", "100g is 4–5 servings" → ~400–500. Leave corrections empty when they are only asking a question or chatting with no clear new number.
- Whole-day narrations produce many entries; infer meal_slot from words like morning/lunch/evening, else "unknown".
- Steps count as exercise: "walked 8000 steps" → exercise "walking (8000 steps)", ≈ 280 kcal.
- Weigh-ins: "weighed 82", "82.4 kg today" → weight_kg. Never create an entry for it.
- Keep native/vernacular dish names as spoken (poha, dal, dosa, chai). Hinglish is common — transcribe faithfully.
- For photos: identify the dish(es) and portion from what is visible; confidence "low" unless obvious.
- confidence "low" whenever the item or portion is ambiguous, OR you are unsure of this food's typical kcal (unfamiliar / regional / homemade / variable street food, or you do not know kcal per 100g). Low confidence triggers a web lookup — prefer low over a confident wrong guess.
- transcript: verbatim transcription for audio; for text input echo the text; for photos a one-line description.
- Non-food, non-fitness input with no question → intent "chat", chat_text = the input; entries empty.
- quantity_hint: short string when a quantity was stated ("100 g", "2", "1 bowl"); null if unspecified.`

type InputPart =
  | { type: "text"; text: string }
  | { type: "input_audio"; input_audio: { data: string; format: "mp3" | "wav" } }
  | { type: "image_url"; image_url: { url: string } };

export async function extract(
  parts: InputPart[],
  localTimeHint: string,
  alreadyLoggedToday: string[] = [],
): Promise<Extraction> {
  const loggedNote = alreadyLoggedToday.length
    ? `\nAlready logged today (re-mentions of these are chat, not new entries): ${alreadyLoggedToday.join(", ")}`
    : "";
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: `User's local time: ${localTimeHint}${loggedNote}` },
        ...parts,
      ],
    },
  ];
  const raw = await chat({
    model: config.modelCheap,
    messages,
    jsonSchema: { name: "extraction", schema: EXTRACTION_SCHEMA },
  });
  const parsed = parseJsonLenient<Extraction>(raw);
  // Older/partial model replies may omit corrections; normalize.
  if (!Array.isArray(parsed.corrections)) parsed.corrections = [];
  return parsed;
}
