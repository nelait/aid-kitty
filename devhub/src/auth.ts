import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response, Router } from "express";
import express from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Config, OidcConfig } from "./config.js";
import { audit, getUser, getUserByEmail, nowIso, type Db, type User } from "./db.js";
import { assertCanActivate, LicenseLimitError } from "./license.js";

const COOKIE = "devhub_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface Principal {
  /** null for the automation token, which acts as an org admin without a user record. */
  user: User | null;
  isAdmin: boolean;
  csrf: string | null;
  label: string;
}

declare module "express-serve-static-core" {
  interface Request {
    principal?: Principal;
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export async function createSession(db: Db, cfg: Config, res: Response, user: User): Promise<void> {
  const token = randomToken();
  await db.run(
    "INSERT INTO web_sessions (token_hash, user_id, csrf, expires_at) VALUES (?, ?, ?, ?)",
    sha256(token),
    user.id,
    randomToken(16),
    new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  );
  const secure = cfg.publicUrl.startsWith("https://") ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`,
  );
}

/** Resolves the caller from the session cookie or the automation bearer token. Never rejects. */
export function identify(db: Db, cfg: Config) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (bearer && cfg.adminToken && safeEqual(bearer, cfg.adminToken)) {
      req.principal = { user: null, isAdmin: true, csrf: null, label: "admin-token" };
      return next();
    }
    const token = readCookie(req, COOKIE);
    try {
      if (token) {
        const s = await db.get<{ user_id: number; csrf: string; expires_at: string }>(
          "SELECT user_id, csrf, expires_at FROM web_sessions WHERE token_hash = ?",
          sha256(token),
        );
        if (s && s.expires_at > nowIso()) {
          const user = await getUser(db, s.user_id);
          if (user && user.status === "active") {
            req.principal = { user, isAdmin: user.role === "admin", csrf: s.csrf, label: user.email };
          }
        }
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}

/**
 * Cookie-authenticated writes must carry the session's CSRF token, as the `_csrf` form
 * field or the `x-devhub-csrf` header. The bearer automation token is exempt.
 */
export function csrfOk(req: Request): boolean {
  const p = req.principal;
  if (!p) return false;
  if (p.csrf === null) return true;
  const sent = (req.body && typeof req.body === "object" ? req.body._csrf : undefined) ?? req.headers["x-devhub-csrf"];
  return typeof sent === "string" && safeEqual(sent, p.csrf);
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
  if (!req.principal) return res.status(401).json({ error: "not signed in" });
  if (req.method !== "GET" && !csrfOk(req)) return res.status(403).json({ error: "missing or bad CSRF token" });
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.principal) return res.status(401).json({ error: "not signed in" });
  if (!req.principal.isAdmin) return res.status(403).json({ error: "admin only" });
  if (req.method !== "GET" && !csrfOk(req)) return res.status(403).json({ error: "missing or bad CSRF token" });
  next();
}

function emailAllowed(cfg: Config, email: string): boolean {
  const domains = cfg.auth.allowedEmailDomains;
  if (domains.length === 0) return true;
  const d = email.split("@")[1]?.toLowerCase();
  return !!d && domains.map((x) => x.toLowerCase()).includes(d);
}

/** Find or create the user for an SSO identity; links an admin-created user by email on first login. */
export async function upsertSsoUser(
  db: Db,
  cfg: Config,
  claims: { sub: string; email: string; name?: string; groups?: string[] },
): Promise<User | { error: string }> {
  claims = { ...claims, email: claims.email.toLowerCase() };
  if (!emailAllowed(cfg, claims.email)) return { error: "email domain not allowed" };
  let user =
    (await db.get<User>("SELECT * FROM users WHERE oidc_sub = ?", claims.sub)) ?? (await getUserByEmail(db, claims.email));
  const groups = claims.groups ?? [];
  const adminGroup = cfg.auth.oidc?.adminGroup;
  if (!user) {
    if (!cfg.auth.jitProvisioning) return { error: "no Dev Hub account; ask an admin to add you" };
    try {
      user = await db.tx(async (q) => {
        await assertCanActivate(q, cfg);
        const team = groups.length
          ? await q.get<{ id: number }>(`SELECT id FROM teams WHERE name IN (${groups.map(() => "?").join(",")}) ORDER BY id LIMIT 1`, ...groups)
          : undefined;
        await q.run(
          "INSERT INTO users (email, name, oidc_sub, team_id, role) VALUES (?, ?, ?, ?, ?)",
          claims.email,
          claims.name ?? null,
          claims.sub,
          team?.id ?? null,
          adminGroup && groups.includes(adminGroup) ? "admin" : "member",
        );
        await audit(q, claims.email, "user.jit_created", { sub: claims.sub, team: team?.id ?? null });
        return (await getUserByEmail(q, claims.email))!;
      });
    } catch (e) {
      if (e instanceof LicenseLimitError) return { error: `can't create your account: ${e.message}` };
      throw e;
    }
  } else {
    if (user.status !== "active") return { error: "account disabled" };
    if (!user.oidc_sub) await db.run("UPDATE users SET oidc_sub = ? WHERE id = ?", claims.sub, user.id);
    else if (user.oidc_sub !== claims.sub) return { error: "this email is linked to a different SSO identity" };
    if (adminGroup && groups.includes(adminGroup) && user.role !== "admin") {
      await db.run("UPDATE users SET role = 'admin' WHERE id = ?", user.id);
    }
    user = (await getUser(db, user.id))!;
  }
  return user;
}

interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

class OidcClient {
  private discovery?: Promise<OidcDiscovery>;
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  private pending = new Map<string, { verifier: string; nonce: string; returnTo: string; exp: number }>();

  constructor(
    private oidc: OidcConfig,
    private redirectUri: string,
  ) {}

  private discover(): Promise<OidcDiscovery> {
    this.discovery ??= fetch(`${this.oidc.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`)
      .then((r) => {
        if (!r.ok) throw new Error(`OIDC discovery failed: HTTP ${r.status}`);
        return r.json() as Promise<OidcDiscovery>;
      })
      .catch((e) => {
        this.discovery = undefined;
        throw e;
      });
    return this.discovery;
  }

  async authorizeUrl(returnTo: string): Promise<string> {
    const d = await this.discover();
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.exp < now) this.pending.delete(k);
    const state = randomToken(16);
    const verifier = randomToken(32);
    const nonce = randomToken(16);
    this.pending.set(state, { verifier, nonce, returnTo, exp: now + 10 * 60 * 1000 });
    const u = new URL(d.authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: "code",
      client_id: this.oidc.clientId,
      redirect_uri: this.redirectUri,
      scope: "openid email profile groups",
      state,
      nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return u.toString();
  }

  async callback(code: string, state: string) {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || p.exp < Date.now()) throw new Error("login expired or invalid state; try again");
    const d = await this.discover();
    const tokenRes = await fetch(d.token_endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: "Basic " + Buffer.from(`${encodeURIComponent(this.oidc.clientId)}:${encodeURIComponent(this.oidc.clientSecret)}`).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.redirectUri,
        code_verifier: p.verifier,
      }),
    });
    if (!tokenRes.ok) throw new Error(`token exchange failed: HTTP ${tokenRes.status}`);
    const { id_token } = (await tokenRes.json()) as { id_token?: string };
    if (!id_token) throw new Error("IdP returned no id_token");
    this.jwks ??= createRemoteJWKSet(new URL(d.jwks_uri));
    const { payload } = await jwtVerify(id_token, this.jwks, { issuer: d.issuer, audience: this.oidc.clientId });
    if (payload.nonce !== p.nonce) throw new Error("nonce mismatch");
    return { payload, returnTo: p.returnTo };
  }

  claims(payload: JWTPayload) {
    const email = (payload.email as string | undefined) ?? (payload.preferred_username as string | undefined);
    if (!payload.sub || !email) throw new Error("ID token has no sub or email");
    if (payload.email_verified === false) throw new Error("email not verified at the IdP");
    const raw = payload[this.oidc.groupsClaim ?? "groups"];
    return {
      sub: payload.sub,
      email,
      name: payload.name as string | undefined,
      groups: Array.isArray(raw) ? raw.map(String) : [],
    };
  }
}

const safeReturnTo = (v: unknown) => (typeof v === "string" && v.startsWith("/") && !v.startsWith("//") ? v : "/");

export function authRoutes(db: Db, cfg: Config): Router {
  const r = express.Router();
  const oidc = cfg.auth.oidc ? new OidcClient(cfg.auth.oidc, `${cfg.publicUrl}/auth/callback`) : null;

  r.get("/auth/login", async (req, res) => {
    if (!oidc) return res.status(404).send("SSO is not configured");
    try {
      res.redirect(await oidc.authorizeUrl(safeReturnTo(req.query.return_to)));
    } catch (e) {
      res.status(502).send(`SSO unavailable: ${(e as Error).message}`);
    }
  });

  r.get("/auth/callback", async (req, res) => {
    if (!oidc) return res.status(404).send("SSO is not configured");
    if (typeof req.query.error === "string") return res.status(401).send(`Sign-in failed: ${req.query.error}`);
    try {
      const { payload, returnTo } = await oidc.callback(String(req.query.code ?? ""), String(req.query.state ?? ""));
      const result = await upsertSsoUser(db, cfg, oidc.claims(payload));
      if ("error" in result) return res.status(403).send(`Sign-in refused: ${result.error}`);
      await createSession(db, cfg, res, result);
      await audit(db, result.email, "auth.login", { method: "oidc" });
      res.redirect(returnTo);
    } catch (e) {
      res.status(401).send(`Sign-in failed: ${(e as Error).message}`);
    }
  });

  r.post("/auth/dev-login", express.urlencoded({ extended: false }), async (req, res, next) => {
   try {
    if (!cfg.auth.devLogin) return res.status(404).send("dev login is disabled");
    const email = String(req.body.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) return res.status(400).send("enter an email address");
    const result = await upsertSsoUser(db, cfg, { sub: `dev|${email}`, email });
    if ("error" in result) return res.status(403).send(result.error);
    await createSession(db, cfg, res, result);
    await audit(db, email, "auth.login", { method: "dev" });
    res.redirect("/");
   } catch (e) {
    next(e);
   }
  });

  r.post("/auth/logout", express.urlencoded({ extended: false }), async (req, res, next) => {
    try {
      const token = readCookie(req, COOKIE);
      if (token) await db.run("DELETE FROM web_sessions WHERE token_hash = ?", sha256(token));
      res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
      res.redirect("/");
    } catch (e) {
      next(e);
    }
  });

  return r;
}
