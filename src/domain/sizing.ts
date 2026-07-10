import { db, normalizeName, type User } from "../db/index.js";
import { config } from "../config.js";
import type { ExtractedEntry } from "../llm/extract.js";

export interface SizedEntry extends ExtractedEntry {
  sizeSource: "override" | "cache" | "llm";
}

// Sizing waterfall: personal override → global cache → LLM's own guess.
// (Bundled food/exercise DBs slot in between cache and LLM later.)
export function applySizing(user: User, entry: ExtractedEntry): SizedEntry {
  const key = normalizeName(entry.name);

  const override = db
    .prepare("SELECT size, kcal_estimate FROM overrides WHERE user_id = ? AND name_normalized = ?")
    .get(user.id, key) as { size: SizedEntry["size"]; kcal_estimate: number | null } | undefined;
  if (override) {
    return {
      ...entry,
      size: override.size,
      kcal_estimate: override.kcal_estimate ?? entry.kcal_estimate,
      confidence: "high",
      sizeSource: "override",
    };
  }

  const cached = db
    .prepare("SELECT size, kcal_estimate FROM size_cache WHERE name_normalized = ?")
    .get(key) as { size: SizedEntry["size"]; kcal_estimate: number | null } | undefined;
  if (cached) {
    return {
      ...entry,
      size: cached.size,
      kcal_estimate: cached.kcal_estimate ?? entry.kcal_estimate,
      sizeSource: "cache",
    };
  }

  // Only cache unambiguous, unquantified names — "biryani" yes, "2 rotis" no.
  if (entry.confidence === "high" && !entry.quantity_hint) {
    db.prepare(
      "INSERT OR IGNORE INTO size_cache (name_normalized, size, kcal_estimate, model) VALUES (?, ?, ?, ?)",
    ).run(key, entry.size, entry.kcal_estimate, config.modelCheap);
  }
  return { ...entry, sizeSource: "llm" };
}

export function saveOverride(userId: number, name: string, size: string, kcal: number | null) {
  db.prepare(
    `INSERT INTO overrides (user_id, name_normalized, size, kcal_estimate, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, name_normalized)
     DO UPDATE SET size = excluded.size, kcal_estimate = excluded.kcal_estimate, updated_at = excluded.updated_at`,
  ).run(userId, normalizeName(name), size, kcal);
}
