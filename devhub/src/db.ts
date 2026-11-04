import { DatabaseSync } from "node:sqlite";

export type Role = "member" | "manager" | "admin";

export interface Team {
  id: number;
  name: string;
  cost_center: string | null;
  /** Shared monthly pool for the whole team; null = no team pool. */
  monthly_pool_cents: number | null;
  /** Default per-member monthly budget; null = org default. */
  member_default_cents: number | null;
}

export interface User {
  id: number;
  email: string;
  name: string | null;
  team_id: number | null;
  role: Role;
  status: "active" | "disabled";
  oidc_sub: string | null;
  claude_user_id: string | null;
  github_login: string | null;
  monthly_budget_cents: number | null;
  created_at: string;
}

export interface RaiseRequest {
  id: number;
  user_id: number;
  period: string;
  amount_cents: number;
  reason: string;
  status: "pending" | "approved" | "denied";
  decided_by: number | null;
  decision_note: string | null;
  decided_at: string | null;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  cost_center TEXT,
  monthly_pool_cents INTEGER,
  member_default_cents INTEGER
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  team_id INTEGER REFERENCES teams(id),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','manager','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  oidc_sub TEXT UNIQUE,
  claude_user_id TEXT UNIQUE,
  github_login TEXT UNIQUE COLLATE NOCASE,
  monthly_budget_cents INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Period-to-date spend per user per tool, replaced on every sync.
CREATE TABLE IF NOT EXISTS spend (
  period TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  tool TEXT NOT NULL,
  cents INTEGER NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (period, user_id, tool)
);
-- Spend a connector reported for an identity we could not match to a user.
CREATE TABLE IF NOT EXISTS unmatched_spend (
  period TEXT NOT NULL,
  tool TEXT NOT NULL,
  external_id TEXT NOT NULL,
  cents INTEGER NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (period, tool, external_id)
);
CREATE TABLE IF NOT EXISTS raise_requests (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  period TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  decided_by INTEGER REFERENCES users(id),
  decision_note TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Last cap pushed to the Claude spend-limits API, to avoid redundant writes.
CREATE TABLE IF NOT EXISTS claude_caps (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  period TEXT NOT NULL,
  cents INTEGER NOT NULL,
  pushed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  connector TEXT NOT NULL,
  ok INTEGER NOT NULL,
  message TEXT
);
CREATE TABLE IF NOT EXISTS web_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  csrf TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);
`;

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function audit(db: Db, actor: string, action: string, detail: unknown): void {
  db.prepare("INSERT INTO audit (actor, action, detail) VALUES (?, ?, ?)").run(
    actor,
    action,
    JSON.stringify(detail),
  );
}

export const nowIso = (): string => new Date().toISOString();

export function getUser(db: Db, id: number): User | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User | undefined;
}

export function getUserByEmail(db: Db, email: string): User | undefined {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email) as User | undefined;
}

export function getTeam(db: Db, id: number | null): Team | undefined {
  if (id === null) return undefined;
  return db.prepare("SELECT * FROM teams WHERE id = ?").get(id) as Team | undefined;
}
