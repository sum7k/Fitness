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
  size TEXT NOT NULL,
  kcal_estimate REAL,
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
  size TEXT NOT NULL,
  kcal_estimate REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, name_normalized)
);

CREATE TABLE IF NOT EXISTS size_cache (
  name_normalized TEXT PRIMARY KEY,
  size TEXT NOT NULL,
  kcal_estimate REAL,
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
`);

// Migrations for DBs created before the Mifflin-St Jeor columns existed.
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
  size: string;
  kcal_estimate: number | null;
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
