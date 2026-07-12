import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  tg_user_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  name TEXT,
  weight_kg REAL,
  sex TEXT,                  -- male | female
  height_cm REAL,
  age INTEGER,
  activity TEXT,             -- sedentary | light | moderate | active (baseline lifestyle, EXCLUDING workouts)
  exercise_goal_days INTEGER,-- planned workout days/week; a buddy accountability target, NOT part of the budget
  goal TEXT,                 -- lose | maintain | gain | custom
  pace TEXT,                 -- rate label
  pending_rate REAL,         -- proposed weekly kg rate awaiting the user's confirmation
  daily_budget_units REAL,
  tz TEXT NOT NULL,
  onboarding_state TEXT      -- 'chat' during conversational setup, NULL when done
);

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,        -- food | exercise
  name TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  kcal_estimate REAL NOT NULL,
  meal_slot TEXT,
  confidence TEXT,
  source TEXT NOT NULL,      -- voice | photo | text
  logged_at TEXT NOT NULL DEFAULT (datetime('now')),
  day_local TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_user_day ON entries(user_id, day_local);

CREATE TABLE IF NOT EXISTS weights (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  weight_kg REAL NOT NULL,
  measured_at TEXT NOT NULL DEFAULT (datetime('now')),
  day_local TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS overrides (
  user_id INTEGER NOT NULL REFERENCES users(id),
  name_normalized TEXT NOT NULL,
  kcal_estimate REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, name_normalized)
);

CREATE TABLE IF NOT EXISTS kcal_cache (
  name_normalized TEXT PRIMARY KEY,
  kcal_estimate REAL NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,        -- user | assistant
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS allowed_users (
  tg_user_id INTEGER PRIMARY KEY,
  allowed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Existing DB users stay in after the gate is turned on.
db.exec(`
INSERT OR IGNORE INTO allowed_users (tg_user_id)
SELECT tg_user_id FROM users
`);

// ---- migrations for older DBs ----

{
  const cols = new Set(
    (db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  const adds: Array<[string, string]> = [
    ["name", "TEXT"],
    ["sex", "TEXT"],
    ["height_cm", "REAL"],
    ["age", "INTEGER"],
    ["activity", "TEXT"],
    ["exercise_goal_days", "INTEGER"],
    ["pending_rate", "REAL"],
  ];
  for (const [name, decl] of adds) {
    if (!cols.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${decl}`);
  }
}

// Drop legacy t-shirt `size` columns; backfill kcal from size midpoints first.
{
  const SIZE_MID: Record<string, number> = {
    XS: 50, S: 100, M: 200, L: 400, XL: 600, XXL: 800, XXXL: 1200,
  };

  const entryCols = new Set(
    (db.prepare("PRAGMA table_info(entries)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (entryCols.has("size")) {
    const rows = db
      .prepare("SELECT id, size, kcal_estimate FROM entries")
      .all() as Array<{ id: number; size: string; kcal_estimate: number | null }>;
    const upd = db.prepare("UPDATE entries SET kcal_estimate = ? WHERE id = ?");
    for (const r of rows) {
      if (r.kcal_estimate == null || !Number.isFinite(r.kcal_estimate)) {
        upd.run(SIZE_MID[r.size] ?? 200, r.id);
      }
    }
    db.exec("UPDATE entries SET kcal_estimate = 200 WHERE kcal_estimate IS NULL");
    db.exec("ALTER TABLE entries DROP COLUMN size");
  }

  const overrideCols = new Set(
    (db.prepare("PRAGMA table_info(overrides)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (overrideCols.has("size")) {
    db.exec("UPDATE overrides SET kcal_estimate = 200 WHERE kcal_estimate IS NULL");
    // Drop size; keep rows that have kcal.
    db.exec("ALTER TABLE overrides DROP COLUMN size");
  }

  // size_cache → kcal_cache
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map((t) => t.name),
  );
  if (tables.has("size_cache")) {
    db.exec(`
      INSERT OR IGNORE INTO kcal_cache (name_normalized, kcal_estimate, model, created_at)
      SELECT name_normalized,
             COALESCE(kcal_estimate,
               CASE size
                 WHEN 'XS' THEN 50 WHEN 'S' THEN 100 WHEN 'M' THEN 200
                 WHEN 'L' THEN 400 WHEN 'XL' THEN 600 WHEN 'XXL' THEN 800
                 WHEN 'XXXL' THEN 1200 ELSE 200 END),
             model, created_at
      FROM size_cache
      WHERE name_normalized IS NOT NULL
    `);
    db.exec("DROP TABLE size_cache");
  }
}

export interface User {
  id: number;
  tg_user_id: number;
  name: string | null;
  weight_kg: number | null;
  sex: string | null;
  height_cm: number | null;
  age: number | null;
  activity: string | null;
  exercise_goal_days: number | null;
  goal: string | null;
  pace: string | null;
  pending_rate: number | null;
  daily_budget_units: number | null;
  tz: string;
  onboarding_state: string | null;
}

export interface Entry {
  id: number;
  user_id: number;
  kind: "food" | "exercise";
  name: string;
  name_normalized: string;
  kcal_estimate: number;
  meal_slot: string | null;
  confidence: string | null;
  source: string;
  logged_at: string;
  day_local: string;
}

export function getOrCreateUser(tgUserId: number): User {
  const found = db
    .prepare("SELECT * FROM users WHERE tg_user_id = ?")
    .get(tgUserId) as User | undefined;
  if (found) return found;
  db.prepare("INSERT INTO users (tg_user_id, tz) VALUES (?, ?)").run(
    tgUserId,
    config.defaultTimezone,
  );
  return getOrCreateUser(tgUserId);
}

export function dayLocal(tz: string, date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(date);
}

export function normalizeName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, " ");
}
