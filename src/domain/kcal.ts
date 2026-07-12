import { db, normalizeName, type User } from "../db/index.js";
import { config } from "../config.js";
import type { ExtractedEntry } from "../llm/extract.js";
import { lookupFoodKcal } from "../llm/lookup.js";

export interface ResolvedEntry extends ExtractedEntry {
  kcalSource: "override" | "cache" | "llm" | "web";
}

/** True when we should spend a web lookup: food, no personal/global memory, and
 *  either the model is unsure or the user gave a mass/volume (easy to mis-scale). */
export function needsWebLookup(entry: ResolvedEntry): boolean {
  if (entry.kind !== "food" || entry.kcalSource !== "llm") return false;
  if (entry.confidence === "low") return true;
  const q = entry.quantity_hint?.toLowerCase() ?? "";
  return /\d/.test(q) && /\b(g|gm|gms|gram|grams|kg|ml|l|liter|litre|oz)\b/.test(q);
}

// Waterfall: personal override → global cache → LLM estimate.
// Quantified entries skip override/cache — those store a typical serving, not "100g".
export function resolveKcal(user: User, entry: ExtractedEntry): ResolvedEntry {
  const key = normalizeName(entry.name);
  const quantified = Boolean(entry.quantity_hint?.trim());

  if (!quantified) {
    const override = db
      .prepare("SELECT kcal_estimate FROM overrides WHERE user_id = ? AND name_normalized = ?")
      .get(user.id, key) as { kcal_estimate: number | null } | undefined;
    if (override?.kcal_estimate != null) {
      return {
        ...entry,
        kcal_estimate: Math.round(override.kcal_estimate),
        confidence: "high",
        kcalSource: "override",
      };
    }

    const cached = db
      .prepare("SELECT kcal_estimate FROM kcal_cache WHERE name_normalized = ?")
      .get(key) as { kcal_estimate: number | null } | undefined;
    if (cached?.kcal_estimate != null) {
      return {
        ...entry,
        kcal_estimate: Math.round(cached.kcal_estimate),
        kcalSource: "cache",
      };
    }
  }

  const kcal = Math.round(entry.kcal_estimate);
  // Cache unambiguous, unquantified, high-confidence guesses. Low-confidence
  // skips cache so a later web lookup (or a better estimate) can land cleanly.
  if (entry.confidence === "high" && !quantified) {
    cacheKcal(entry.name, kcal);
  }
  return { ...entry, kcal_estimate: kcal, kcalSource: "llm" };
}

/** Persist a typical-serving estimate into the global cache (unquantified only). */
export function cacheKcal(name: string, kcal: number) {
  db.prepare(
    "INSERT OR IGNORE INTO kcal_cache (name_normalized, kcal_estimate, model) VALUES (?, ?, ?)",
  ).run(normalizeName(name), Math.round(kcal), config.modelCheap);
}

/**
 * If the extract model was unsure and we have no override/cache, search the web
 * and replace the estimate. Falls back to the LLM number on lookup failure.
 */
export async function enrichFromWeb(entry: ResolvedEntry): Promise<ResolvedEntry> {
  if (!needsWebLookup(entry)) return entry;

  const looked = await lookupFoodKcal(entry.name, entry.quantity_hint, entry.kcal_estimate);
  if (!looked) return entry;

  const quantified = Boolean(entry.quantity_hint?.trim());
  if (!quantified) cacheKcal(entry.name, looked.kcal);

  return {
    ...entry,
    kcal_estimate: looked.kcal,
    confidence: "high",
    kcalSource: "web",
  };
}

export function saveOverride(userId: number, name: string, kcal: number) {
  db.prepare(
    `INSERT INTO overrides (user_id, name_normalized, kcal_estimate, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, name_normalized)
     DO UPDATE SET kcal_estimate = excluded.kcal_estimate, updated_at = excluded.updated_at`,
  ).run(userId, normalizeName(name), kcal);
}
