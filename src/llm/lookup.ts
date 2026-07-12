import { chat, parseJsonLenient } from "./openrouter.js";
import { config } from "../config.js";
import { debug, error } from "../log.js";

const LOOKUP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kcal_estimate: { type: "number" },
    note: { type: "string" },
  },
  required: ["kcal_estimate", "note"],
};

/**
 * Web-grounded kcal estimate for one food. Code decides when to call this;
 * the web plugin always runs one search so the model cannot skip it.
 */
export async function lookupFoodKcal(
  name: string,
  quantityHint: string | null,
  priorEstimate: number | null = null,
): Promise<{ kcal: number; note: string } | null> {
  const qty = quantityHint?.trim() || "1 typical serving";
  const prior = priorEstimate != null ? `\nPrior rough guess (may be wrong): ~${priorEstimate} kcal.` : "";

  try {
    const raw = await chat({
      // Text-only lookup — buddy model is fine and cheaper than multimodal extract.
      model: config.modelBuddy,
      messages: [
        {
          role: "system",
          content:
            "You estimate calories for a fitness logger. Use the web search results. " +
            "Return kcal for the TOTAL quantity stated (scale by grams/ml when given — " +
            "never treat 100g of a light snack as one tiny serving). " +
            "Prefer nutrition labels / databases over blogs. Round to nearest 10–25. " +
            "note: one short plain-text sentence, no markdown.",
        },
        {
          role: "user",
          content:
            `Food: ${name}\nQuantity: ${qty}${prior}\n` +
            "Search the web for calorie info, then reply with JSON only.",
        },
      ],
      // Plugin always searches once — we already decided this food needs a lookup.
      plugins: [{ id: "web", engine: "exa", max_results: 5 }],
      jsonSchema: { name: "food_kcal_lookup", schema: LOOKUP_SCHEMA },
      maxTokens: 300,
    });
    const parsed = parseJsonLenient<{ kcal_estimate: number; note: string }>(raw);
    const kcal = Math.round(parsed.kcal_estimate);
    if (!Number.isFinite(kcal) || kcal < 10 || kcal > 5000) {
      debug(`web lookup rejected out-of-range kcal for "${name}": ${parsed.kcal_estimate}`);
      return null;
    }
    debug(`web lookup "${name}" (${qty}): ~${kcal} kcal — ${parsed.note.slice(0, 80)}`);
    return { kcal, note: parsed.note.slice(0, 200) };
  } catch (err) {
    error(`web lookup failed for "${name}":`, err);
    return null;
  }
}
