import { db, normalizeName, type User } from "../db/index.js";
import { config } from "../config.js";
import type { ExtractedEntry } from "../llm/extract.js";

export interface ResolvedEntry extends ExtractedEntry {
  kcalSource: "override" | "cache" | "llm";
}

// Waterfall: personal override → global cache → LLM estimate.
export function resolveKcal(user: User, entry: ExtractedEntry): ResolvedEntry {
  const key = normalizeName(entry.name);

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

  const kcal = Math.round(entry.kcal_estimate);

  // Only cache unambiguous, unquantified names — "biryani" yes, "2 rotis" no.
  if (entry.confidence === "high" && !entry.quantity_hint) {
    db.prepare(
      "INSERT OR IGNORE INTO kcal_cache (name_normalized, kcal_estimate, model) VALUES (?, ?, ?)",
    ).run(key, kcal, config.modelCheap);
  }
  return { ...entry, kcal_estimate: kcal, kcalSource: "llm" };
}

export function saveOverride(userId: number, name: string, kcal: number) {
  db.prepare(
    `INSERT INTO overrides (user_id, name_normalized, kcal_estimate, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, name_normalized)
     DO UPDATE SET kcal_estimate = excluded.kcal_estimate, updated_at = excluded.updated_at`,
  ).run(userId, normalizeName(name), kcal);
}
