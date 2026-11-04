import type { Config } from "./config.js";
import { audit, nowIso, type Db, type Team } from "./db.js";
import { HttpError } from "./service.js";

/**
 * One AI usage policy, written once in Dev Hub and translated for each tool:
 *
 *   Claude Code  managed settings (served live to a policyHelper, or as a file for MDM),
 *                and the Claude apps gateway's per-group `managed.policies` block
 *   Copilot      org content exclusions (protected paths), applied on request
 *   Cursor       no admin policy API yet: not covered
 *
 * Teams can only tighten the org policy (add denies, narrow allowlists, turn web access off),
 * never loosen it. That keeps every team's effective policy at least as strict as the org's,
 * whichever team a client claims to be in.
 */

export interface OrgPolicy {
  /** Claude models people may use, e.g. "sonnet", "claude-opus-5-5". Empty = no restriction. */
  allowedModels: string[];
  /** gitignore-style paths AI tools must not read or edit, e.g. "**\/.env", "secrets/**". */
  protectedPaths: string[];
  /** Shell command patterns Claude Code must not run, e.g. "rm -rf *", "curl * | sh". */
  deniedCommands: string[];
  /** MCP servers people may add (names or URL patterns). null = any server. */
  allowedMcpServers: string[] | null;
  /** MCP servers that are always blocked. */
  deniedMcpServers: string[];
  /** Whether Claude Code may fetch web pages and search the web. */
  webAccess: boolean;
  /** Stop people from switching Claude Code into bypass-permissions mode. */
  blockBypassPermissions: boolean;
  /** Extra Claude Code managed settings merged in as-is (advanced), e.g. forceLoginMethod. */
  extraClaudeSettings: Record<string, unknown>;
}

export interface TeamPolicy {
  /** null = same as the org. Otherwise a subset of the org's list. */
  allowedModels: string[] | null;
  protectedPaths: string[];
  deniedCommands: string[];
  /** null = same as the org. Otherwise a subset of the org's list (when the org has one). */
  allowedMcpServers: string[] | null;
  deniedMcpServers: string[];
  /** null = same as the org; false turns web access off for the team. */
  webAccess: boolean | null;
}

export const DEFAULT_ORG_POLICY: OrgPolicy = {
  allowedModels: [],
  protectedPaths: ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/secrets/**"],
  deniedCommands: [],
  allowedMcpServers: null,
  deniedMcpServers: [],
  webAccess: true,
  blockBypassPermissions: true,
  extraClaudeSettings: {},
};

export const EMPTY_TEAM_POLICY: TeamPolicy = {
  allowedModels: null,
  protectedPaths: [],
  deniedCommands: [],
  allowedMcpServers: null,
  deniedMcpServers: [],
  webAccess: null,
};

// ------------------------------------------------------------------ validation

const MODEL_RE = /^[a-z0-9][a-z0-9.\-]{0,63}$/;
const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MCP_URL_RE = /^https?:\/\/[^\s"]{1,200}$/;
const isMcpUrl = (s: string) => s.includes("://");

function list(v: unknown, field: string, check: (s: string) => string | null, max = 100): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new HttpError(400, `${field} must be a list`);
  if (v.length > max) throw new HttpError(400, `${field}: at most ${max} entries`);
  const out: string[] = [];
  for (const raw of v) {
    const s = String(raw ?? "").trim();
    if (!s) continue;
    const err = check(s);
    if (err) throw new HttpError(400, `${field}: "${s.slice(0, 80)}" ${err}`);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

const checkModel = (s: string) => (MODEL_RE.test(s) ? null : "isn't a model name or alias (lowercase letters, digits, dots, dashes)");
const checkPath = (s: string) =>
  s.length > 200 ? "is too long" : /[\n\r()]/.test(s) ? "can't contain line breaks or parentheses" : s.startsWith("!") ? "can't start with ! (negation isn't supported here)" : null;
const checkCommand = (s: string) => (s.length > 200 ? "is too long" : /[\n\r]/.test(s) ? "can't contain line breaks" : /\)$/.test(s) ? "can't end with )" : null);
const checkMcp = (s: string) =>
  MCP_NAME_RE.test(s) || MCP_URL_RE.test(s) ? null : "isn't a server name (letters, digits, - and _) or an http(s) URL pattern";

const bool = (v: unknown, field: string): boolean => {
  if (typeof v === "boolean") return v;
  throw new HttpError(400, `${field} must be true or false`);
};

export function validateOrgPolicy(b: Record<string, unknown>): OrgPolicy {
  const extra = b.extraClaudeSettings ?? {};
  if (typeof extra !== "object" || Array.isArray(extra) || extra === null) {
    throw new HttpError(400, "extraClaudeSettings must be a JSON object");
  }
  if (JSON.stringify(extra).length > 20_000) throw new HttpError(400, "extraClaudeSettings is too large");
  for (const k of ["permissions", "availableModels", "allowedMcpServers", "deniedMcpServers", "policyHelper"]) {
    if (k in extra) throw new HttpError(400, `extraClaudeSettings can't set ${k}; use the policy fields instead`);
  }
  return {
    allowedModels: list(b.allowedModels, "allowedModels", checkModel),
    protectedPaths: list(b.protectedPaths, "protectedPaths", checkPath, 200),
    deniedCommands: list(b.deniedCommands, "deniedCommands", checkCommand, 200),
    allowedMcpServers: b.allowedMcpServers === null || b.allowedMcpServers === undefined ? null : list(b.allowedMcpServers, "allowedMcpServers", checkMcp),
    deniedMcpServers: list(b.deniedMcpServers, "deniedMcpServers", checkMcp),
    webAccess: b.webAccess === undefined ? true : bool(b.webAccess, "webAccess"),
    blockBypassPermissions: b.blockBypassPermissions === undefined ? true : bool(b.blockBypassPermissions, "blockBypassPermissions"),
    extraClaudeSettings: extra as Record<string, unknown>,
  };
}

/** Validate a team policy and check it only tightens the org policy. */
export function validateTeamPolicy(b: Record<string, unknown>, org: OrgPolicy): TeamPolicy {
  const t: TeamPolicy = {
    allowedModels: b.allowedModels === null || b.allowedModels === undefined ? null : list(b.allowedModels, "allowedModels", checkModel),
    protectedPaths: list(b.protectedPaths, "protectedPaths", checkPath, 200),
    deniedCommands: list(b.deniedCommands, "deniedCommands", checkCommand, 200),
    allowedMcpServers: b.allowedMcpServers === null || b.allowedMcpServers === undefined ? null : list(b.allowedMcpServers, "allowedMcpServers", checkMcp),
    deniedMcpServers: list(b.deniedMcpServers, "deniedMcpServers", checkMcp),
    webAccess: b.webAccess === null || b.webAccess === undefined ? null : bool(b.webAccess, "webAccess"),
  };
  if (t.allowedModels && org.allowedModels.length) {
    const extra = t.allowedModels.filter((m) => !org.allowedModels.includes(m));
    if (extra.length) throw new HttpError(400, `allowedModels: ${extra.join(", ")} isn't allowed by the org policy; teams can only narrow it`);
  }
  if (t.allowedMcpServers && org.allowedMcpServers) {
    const extra = t.allowedMcpServers.filter((m) => !org.allowedMcpServers!.includes(m));
    if (extra.length) throw new HttpError(400, `allowedMcpServers: ${extra.join(", ")} isn't allowed by the org policy; teams can only narrow it`);
  }
  if (t.webAccess === true && !org.webAccess) throw new HttpError(400, "webAccess: the org policy turns web access off; a team can't turn it back on");
  return t;
}

// ------------------------------------------------------------------ storage

export async function getOrgPolicy(db: Db): Promise<OrgPolicy> {
  const row = await db.get<{ doc: string }>("SELECT doc FROM policies WHERE scope = 'org'");
  return row ? { ...DEFAULT_ORG_POLICY, ...JSON.parse(row.doc) } : DEFAULT_ORG_POLICY;
}

export async function getTeamPolicy(db: Db, teamId: number): Promise<TeamPolicy> {
  const row = await db.get<{ doc: string }>("SELECT doc FROM policies WHERE scope = ?", `team:${teamId}`);
  return row ? { ...EMPTY_TEAM_POLICY, ...JSON.parse(row.doc) } : EMPTY_TEAM_POLICY;
}

async function store(db: Db, scope: string, doc: unknown, actor: string) {
  const before = await db.get<{ doc: string }>("SELECT doc FROM policies WHERE scope = ?", scope);
  await db.run(
    "INSERT INTO policies (scope, doc, updated_at, updated_by) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(scope) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
    scope,
    JSON.stringify(doc),
    nowIso(),
    actor,
  );
  await audit(db, actor, "policy.saved", { scope, before: before ? JSON.parse(before.doc) : null, after: doc });
}

export async function saveOrgPolicy(db: Db, body: Record<string, unknown>, actor: string): Promise<OrgPolicy> {
  const org = validateOrgPolicy(body);
  // A tighter org policy can make existing team narrowing invalid; tell the admin which teams.
  const teams = await db.all<Team>("SELECT * FROM teams ORDER BY name");
  for (const t of teams) {
    try {
      validateTeamPolicy({ ...(await getTeamPolicy(db, t.id)) }, org);
    } catch (e) {
      throw new HttpError(400, `Team ${t.name}'s policy would loosen this org policy (${(e as Error).message}). Update the team first.`);
    }
  }
  await store(db, "org", org, actor);
  return org;
}

export async function saveTeamPolicy(db: Db, teamId: number, body: Record<string, unknown>, actor: string): Promise<TeamPolicy> {
  if (!(await db.get("SELECT id FROM teams WHERE id = ?", teamId))) throw new HttpError(404, "team not found");
  const t = validateTeamPolicy(body, await getOrgPolicy(db));
  await store(db, `team:${teamId}`, t, actor);
  return t;
}

export async function policyVersion(db: Db): Promise<string> {
  const row = await db.get<{ v: string | null }>("SELECT MAX(updated_at) AS v FROM policies");
  return row?.v ?? "default";
}

// ------------------------------------------------------------------ effective policy

export interface EffectivePolicy extends OrgPolicy {
  team: string | null;
}

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];

export function effective(org: OrgPolicy, team?: { name: string; policy: TeamPolicy }): EffectivePolicy {
  if (!team) return { ...org, team: null };
  const t = team.policy;
  return {
    ...org,
    team: team.name,
    allowedModels: t.allowedModels ?? org.allowedModels,
    protectedPaths: union(org.protectedPaths, t.protectedPaths),
    deniedCommands: union(org.deniedCommands, t.deniedCommands),
    allowedMcpServers: t.allowedMcpServers ?? org.allowedMcpServers,
    deniedMcpServers: union(org.deniedMcpServers, t.deniedMcpServers),
    webAccess: t.webAccess === null ? org.webAccess : org.webAccess && t.webAccess,
  };
}

export async function effectiveForEmail(db: Db, email: string | undefined): Promise<EffectivePolicy> {
  const org = await getOrgPolicy(db);
  if (!email) return effective(org);
  const row = await db.get<{ team_id: number | null; name: string | null }>(
    "SELECT u.team_id, t.name FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.email = ? AND u.status = 'active' AND u.deleted_at IS NULL",
    email.toLowerCase(),
  );
  if (!row?.team_id || !row.name) return effective(org);
  return effective(org, { name: row.name, policy: await getTeamPolicy(db, row.team_id) });
}

// ------------------------------------------------------------------ translations

const mcpEntry = (s: string) => (isMcpUrl(s) ? { serverUrl: s } : { serverName: s });

/** Claude Code managed settings for one effective policy. */
export function claudeSettings(p: OrgPolicy): Record<string, unknown> {
  const deny = [
    ...p.protectedPaths.flatMap((path) => [`Read(${path})`, `Edit(${path})`]),
    ...p.deniedCommands.map((c) => `Bash(${c})`),
    ...(p.webAccess ? [] : ["WebFetch", "WebSearch"]),
  ];
  const permissions: Record<string, unknown> = {};
  if (deny.length) permissions.deny = deny;
  if (p.blockBypassPermissions) permissions.disableBypassPermissionsMode = "disable";
  const out: Record<string, unknown> = { ...p.extraClaudeSettings };
  if (Object.keys(permissions).length) out.permissions = permissions;
  if (p.allowedModels.length) {
    out.availableModels = p.allowedModels;
    out.enforceAvailableModels = true;
  }
  if (p.allowedMcpServers) out.allowedMcpServers = p.allowedMcpServers.map(mcpEntry);
  if (p.deniedMcpServers.length) out.deniedMcpServers = p.deniedMcpServers.map(mcpEntry);
  return out;
}

/** Minimal YAML writer for plain JSON data; strings are always double-quoted (JSON strings are valid YAML). */
function yaml(v: unknown, indent = 0): string {
  const pad = " ".repeat(indent);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return v
      .map((x) => {
        const inner = yaml(x, indent + 2);
        return typeof x === "object" && x !== null && !Array.isArray(x) && Object.keys(x).length
          ? `\n${pad}- ${inner.trimStart()}`
          : `\n${pad}- ${inner}`;
      })
      .join("");
  }
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return entries
      .map(([k, x]) => {
        const key = /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : JSON.stringify(k);
        const inner = yaml(x, indent + 2);
        return typeof x === "object" && x !== null && (Array.isArray(x) ? x.length : Object.keys(x).length)
          ? `\n${pad}${key}:${inner}`
          : `\n${pad}${key}: ${inner}`;
      })
      .join("");
  }
  return JSON.stringify(v ?? null);
}

/**
 * The Claude apps gateway's `managed` block: one policy per team that has its own rules
 * (matched on the IdP group of the same name), then the org policy as the catch-all.
 * Each team entry carries its full effective settings, so it is correct whichever
 * policy_mode the gateway uses.
 */
/** Keys the gateway docs say must stay out of its `managed` block, or signed-in sessions can exit at startup. */
const GATEWAY_EXCLUDED_KEYS = ["forceLoginMethod", "forceLoginOrgUUID"];

export async function gatewayManagedYaml(db: Db): Promise<string> {
  const stored = await getOrgPolicy(db);
  const extra = Object.fromEntries(Object.entries(stored.extraClaudeSettings).filter(([k]) => !GATEWAY_EXCLUDED_KEYS.includes(k)));
  const org: OrgPolicy = { ...stored, extraClaudeSettings: extra };
  const teams = await db.all<Team>("SELECT * FROM teams ORDER BY name");
  const policies: unknown[] = [];
  for (const t of teams) {
    const tp = await getTeamPolicy(db, t.id);
    if (JSON.stringify(tp) === JSON.stringify(EMPTY_TEAM_POLICY)) continue;
    policies.push({ match: { groups: [t.name] }, cli: claudeSettings(effective(org, { name: t.name, policy: tp })) });
  }
  policies.push({ match: {}, cli: claudeSettings(org) });
  return (
    `# Generated by Dev Hub ${nowIso().slice(0, 16)}Z (policy version ${await policyVersion(db)}).\n` +
    `# Paste into gateway.yaml. Team entries match the IdP group with the team's exact name (case-sensitive).` +
    yaml({ managed: { policies } }) +
    "\n"
  );
}

/** Copilot content exclusion rules for every repository in the org ("*" key). */
export function copilotExclusions(org: OrgPolicy): string[] {
  return org.protectedPaths.map((p) => (p.startsWith("/") || p.startsWith("*") ? p : `**/${p}`));
}

export async function applyCopilotExclusions(db: Db, cfg: Config, actor: string, dryRun: boolean) {
  const c = cfg.connectors.copilot;
  if (!c) throw new HttpError(400, "GitHub isn't configured (set GITHUB_ORG and GITHUB_TOKEN)");
  const url = `${c.apiUrl}/orgs/${encodeURIComponent(c.org)}/copilot/content_exclusion`;
  const headers = { authorization: `Bearer ${c.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new HttpError(502, `GitHub returned ${res.status} reading content exclusions: ${(await res.text()).slice(0, 200)}`);
  const current = (await res.json()) as Record<string, unknown>;
  const wanted = copilotExclusions(await getOrgPolicy(db));
  // Only Dev Hub's "*" entry changes; per-repository rules someone set in GitHub are kept.
  const next: Record<string, unknown> = { ...current };
  if (wanted.length) next["*"] = wanted;
  else delete next["*"];
  const changed = JSON.stringify(current["*"] ?? null) !== JSON.stringify(next["*"] ?? null);
  if (dryRun || !changed) return { changed, current, next };
  const put = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(next),
    signal: AbortSignal.timeout(20_000),
  });
  if (!put.ok) throw new HttpError(502, `GitHub returned ${put.status} saving content exclusions: ${(await put.text()).slice(0, 200)}`);
  await audit(db, actor, "policy.copilot.applied", { before: current["*"] ?? null, after: next["*"] ?? null });
  return { changed, current, next };
}

/**
 * The policyHelper script developers' machines run. It asks Dev Hub for the policy that
 * applies to this person, keeps a copy for when Dev Hub can't be reached, and prints the
 * envelope Claude Code expects. Settings come from /etc/devhub/policy.env (deployed by MDM).
 */
export function helperScript(cfg: Config): string {
  return `#!/bin/sh
# Dev Hub policy helper for Claude Code (policyHelper). Generated by Dev Hub.
# Install at /usr/local/bin/devhub-policy (chmod 755) and register it in managed-settings.json:
#   { "policyHelper": { "path": "/usr/local/bin/devhub-policy", "timeoutMs": 5000, "refreshIntervalMs": 900000 } }
# /etc/devhub/policy.env sets DEVHUB_URL and DEVHUB_POLICY_TOKEN.
set -u
[ -r /etc/devhub/policy.env ] && . /etc/devhub/policy.env
URL="\${DEVHUB_URL:-${cfg.publicUrl}}"
TOKEN="\${DEVHUB_POLICY_TOKEN:-}"
# Who this is, so team rules apply. Teams can only add restrictions, so a wrong or missing
# email falls back to the org policy rather than anything looser.
EMAIL="\${DEVHUB_USER_EMAIL:-$(git config --global user.email 2>/dev/null || true)}"
CACHE_DIR="\${XDG_CACHE_HOME:-$HOME/.cache}/devhub"
CACHE="$CACHE_DIR/claude-policy.json"
mkdir -p "$CACHE_DIR" 2>/dev/null
TMP="$CACHE.$$"
if curl -fsS --max-time 3 -G "$URL/api/policy/claude-code" \\
     -H "authorization: Bearer $TOKEN" --data-urlencode "email=$EMAIL" -o "$TMP" 2>/dev/null \\
   && grep -q '"managedSettings"' "$TMP"; then
  mv "$TMP" "$CACHE"
  cat "$CACHE"
  exit 0
fi
rm -f "$TMP"
# Dev Hub unreachable: keep working on the last policy we saw.
if [ -s "$CACHE" ]; then cat "$CACHE"; exit 0; fi
echo "Dev Hub policy unavailable at $URL and no cached copy yet; connect to the network once and retry." >&2
exit 1
`;
}
