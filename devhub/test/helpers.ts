import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import pg from "pg";
import { openDb, type Db } from "../src/db.js";
import { issueLicense, setLicensePublicKeyForTests } from "../src/license.js";
import { SyncService } from "../src/sync.js";

// A throwaway signing key, so tests exercise real signature checks.
const keys = generateKeyPairSync("ed25519");
export const testPrivateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
setLicensePublicKeyForTests(keys.publicKey.export({ type: "spki", format: "pem" }).toString());

export function testLicense(seats: number, expiresInDays = 365, customer = "Acme"): string {
  const now = Date.now();
  return JSON.stringify(
    issueLicense(testPrivateKeyPem, {
      id: `lic_test_${seats}_${expiresInDays}`,
      customer,
      seats,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + expiresInDays * 86_400_000).toISOString(),
    }),
  );
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
  });

/** In-memory stand-in for the Claude apps gateway / Enterprise spend-limits API. */
export class MockClaude {
  spend = new Map<string, number>(); // user_id -> cents (may be fractional)
  caps = new Map<string, string>(); // user_id -> amount cents string
  capWrites: { user_id: string; amount: string }[] = [];
  pageSize = 2;
  fail = false;
  key = "gw-admin-key";
  url = "";
  private server = createServer(async (req, res) => {
    const u = new URL(req.url!, "http://x");
    if (req.headers["x-api-key"] !== this.key) {
      res.writeHead(401).end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad key" } }));
      return;
    }
    if (this.fail) return void res.writeHead(503).end("unavailable");
    if (req.method === "GET" && u.pathname === "/v1/organizations/spend_limits/effective") {
      const ids = [...new Set([...this.spend.keys(), ...this.caps.keys()])].sort();
      const start = Number(u.searchParams.get("page") ?? 0);
      const slice = ids.slice(start, start + this.pageSize);
      const data = slice.map((id) => ({
        scope: { type: "user", user_id: id },
        period: "monthly",
        amount: this.caps.get(id) ?? null,
        currency: "USD",
        period_to_date_spend: String(this.spend.get(id) ?? 0),
        spend_limit_id: `spl_${id}`,
      }));
      const next = start + this.pageSize < ids.length ? String(start + this.pageSize) : null;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data, next_page: next }));
      return;
    }
    if (req.method === "POST" && u.pathname === "/v1/organizations/spend_limits") {
      const body = JSON.parse(await readBody(req));
      this.caps.set(body.scope.user_id, body.amount);
      this.capWrites.push({ user_id: body.scope.user_id, amount: body.amount });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ type: "spend_limit", ...body }));
      return;
    }
    res.writeHead(404).end("not found");
  });
  async start() {
    this.url = await listen(this.server);
    return this;
  }
  close() {
    this.server.close();
  }
}

/** In-memory stand-in for GitHub's Copilot seats API. */
export class MockGitHub {
  seats: { login: string; plan: string }[] = [];
  /** login -> premium request usage items for the current month */
  premium = new Map<string, { product: string; netAmount: number }[]>();
  premiumCalls = 0;
  url = "";
  private server = createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    if (req.headers.authorization !== "Bearer gh-token") return void res.writeHead(401).end("{}");
    if (u.pathname === "/organizations/acme/settings/billing/premium_request/usage") {
      this.premiumCalls++;
      const user = (u.searchParams.get("user") ?? "").toLowerCase();
      const items = (this.premium.get(user) ?? []).map((i) => ({
        sku: "Copilot Premium Request", model: "GPT-5", unitType: "requests", pricePerUnit: 0.04,
        grossQuantity: 0, grossAmount: i.netAmount, discountQuantity: 0, discountAmount: 0, netQuantity: 0, ...i,
      }));
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ timePeriod: { year: 2026, month: 11 }, organization: "acme", user, usageItems: items }),
      );
      return;
    }
    const m = u.pathname.match(/^\/orgs\/([^/]+)\/copilot\/billing\/seats$/);
    if (!m) return void res.writeHead(404).end("{}");
    const per = Number(u.searchParams.get("per_page"));
    const page = Number(u.searchParams.get("page"));
    const slice = this.seats.slice((page - 1) * per, page * per);
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        total_seats: this.seats.length,
        seats: slice.map((s) => ({ assignee: { login: s.login }, plan_type: s.plan })),
      }),
    );
  });
  async start() {
    this.url = await listen(this.server);
    return this;
  }
  close() {
    this.server.close();
  }
}

/** In-memory stand-in for the Cursor Admin API's team spend endpoint. */
export class MockCursor {
  members: { email: string; spendCents: number }[] = [];
  pageSize = 2;
  url = "";
  private server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Basic " + Buffer.from("cursor-key:").toString("base64")) {
      return void res.writeHead(401).end("{}");
    }
    if (req.method !== "POST" || req.url !== "/teams/spend") return void res.writeHead(404).end("{}");
    const { page } = JSON.parse(await readBody(req));
    const slice = this.members.slice((page - 1) * this.pageSize, page * this.pageSize);
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        teamMemberSpend: slice.map((m) => ({ ...m, name: m.email, role: "member", fastPremiumRequests: 0 })),
        subscriptionCycleStart: Date.now(),
        totalMembers: this.members.length,
        totalPages: Math.max(1, Math.ceil(this.members.length / this.pageSize)),
      }),
    );
  });
  async start() {
    this.url = await listen(this.server);
    return this;
  }
  close() {
    this.server.close();
  }
}

/**
 * A fresh, empty database for one test file: in-memory SQLite by default, or a brand-new
 * Postgres database when DEVHUB_TEST_DATABASE_URL points at a server (dropped afterwards).
 */
export async function freshDb(): Promise<{ db: Db; close(): Promise<void> }> {
  const base = process.env.DEVHUB_TEST_DATABASE_URL;
  if (!base) {
    const db = await openDb(":memory:");
    return { db, close: () => db.close() };
  }
  const name = `devhub_test_${randomBytes(6).toString("hex")}`;
  const admin = async (sql: string) => {
    const c = new pg.Client({ connectionString: base });
    await c.connect();
    try {
      await c.query(sql);
    } finally {
      await c.end();
    }
  };
  await admin(`CREATE DATABASE ${name}`);
  const url = new URL(base);
  url.pathname = `/${name}`;
  const db = await openDb(url.toString());
  return {
    db,
    async close() {
      await db.close();
      await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}

export interface Harness {
  db: Db;
  cfg: Config;
  sync: SyncService;
  url: string;
  claude: MockClaude;
  github: MockGitHub;
  cursor: MockCursor;
  close(): Promise<void>;
}

export async function harness(over: Partial<Config> = {}): Promise<Harness> {
  const claude = await new MockClaude().start();
  const github = await new MockGitHub().start();
  const cursor = await new MockCursor().start();
  const cfg = loadConfig({
    databasePath: ":memory:",
    adminToken: "test-admin-token",
    auth: { devLogin: true, jitProvisioning: true, allowedEmailDomains: [] },
    license: { text: testLicense(1000) },
    wallet: { defaultMonthlyBudgetUsd: 100, warnAt: 0.8 },
    connectors: {
      claude: { mode: "gateway", baseUrl: claude.url, apiKey: claude.key, enforceCaps: true },
      copilot: { org: "acme", token: "gh-token", apiUrl: github.url, seatPriceUsd: { business: 19, enterprise: 39 } },
      cursor: { apiKey: "cursor-key", apiUrl: cursor.url },
    },
    ...over,
  });
  const store = await freshDb();
  const db = store.db;
  const sync = new SyncService(db, cfg);
  const server = createServer(createApp(db, cfg, sync));
  const url = await listen(server);
  cfg.publicUrl = url;
  return {
    db,
    cfg,
    sync,
    url,
    claude,
    github,
    cursor,
    async close() {
      server.closeAllConnections();
      server.close();
      cursor.close();
      claude.close();
      github.close();
      await store.close();
    },
  };
}

/** A signed-in browser-ish client: keeps the session cookie and knows its CSRF token. */
export class Client {
  cookie = "";
  csrf = "";
  constructor(private base: string) {}

  static async login(base: string, email: string): Promise<Client> {
    const c = new Client(base);
    const res = await fetch(`${base}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email }),
      redirect: "manual",
    });
    if (res.status !== 302) throw new Error(`login failed: ${res.status} ${await res.text()}`);
    c.cookie = res.headers.get("set-cookie")!.split(";")[0];
    const me = await c.get("/api/me");
    c.csrf = (await me.json()).csrf;
    return c;
  }

  get(path: string) {
    return fetch(this.base + path, { headers: { cookie: this.cookie }, redirect: "manual" });
  }

  post(path: string, body: unknown, opts: { csrf?: boolean } = {}) {
    const headers: Record<string, string> = { cookie: this.cookie, "content-type": "application/json" };
    if (opts.csrf !== false) headers["x-devhub-csrf"] = this.csrf;
    return fetch(this.base + path, { method: "POST", headers, body: JSON.stringify(body), redirect: "manual" });
  }
}

export function admin(base: string, method: string, path: string, body?: unknown) {
  return fetch(base + path, {
    method,
    headers: { authorization: "Bearer test-admin-token", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
