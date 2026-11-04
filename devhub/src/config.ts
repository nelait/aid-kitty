import { readFileSync, existsSync } from "node:fs";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** IdP group whose members become Dev Hub admins. */
  adminGroup?: string;
  /** ID-token claim that carries group names (Okta default: "groups"). */
  groupsClaim?: string;
}

export interface ClaudeConnectorConfig {
  /**
   * "gateway": a self-hosted Claude apps gateway (users are identified by OIDC `sub`,
   * admin key sent as x-api-key).
   * "enterprise": the Claude Enterprise Admin API at api.anthropic.com (users are
   * identified by `user_...` IDs, scoped key sent as a bearer token).
   */
  mode: "gateway" | "enterprise";
  baseUrl: string;
  apiKey: string;
  /** Push per-user monthly caps so the wallet is enforced live on every request. */
  enforceCaps: boolean;
}

export interface CopilotConnectorConfig {
  org: string;
  token: string;
  apiUrl: string;
  /** Monthly seat price by plan type, USD. */
  seatPriceUsd: Record<string, number>;
}

export interface Config {
  port: number;
  publicUrl: string;
  databasePath: string;
  /** Bearer token for automation (Terraform, scripts). Acts as an admin. */
  adminToken?: string;
  auth: {
    oidc?: OidcConfig;
    /** Email-only login for local development. Never enable in production. */
    devLogin: boolean;
    /** Create a user on first SSO login. */
    jitProvisioning: boolean;
    allowedEmailDomains: string[];
  };
  wallet: {
    defaultMonthlyBudgetUsd: number;
    /** Utilization (0-1) at which the wallet shows a warning. */
    warnAt: number;
  };
  /** Where developers point Claude Code (shown in the portal). */
  claudeGatewayUrl?: string;
  connectors: {
    claude?: ClaudeConnectorConfig;
    copilot?: CopilotConnectorConfig;
  };
  syncIntervalSeconds: number;
  notify: { slackWebhookUrl?: string };
}

const env = process.env;

function num(v: string | undefined, d: number): number {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
}

/** Defaults, overlaid by an optional JSON file (DEVHUB_CONFIG), overlaid by env vars. */
export function loadConfig(overrides: Partial<Config> = {}): Config {
  const file = env.DEVHUB_CONFIG ?? "devhub.config.json";
  const fromFile: Partial<Config> = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : {};

  const base: Config = {
    port: num(env.PORT, 8787),
    publicUrl: env.DEVHUB_PUBLIC_URL ?? "http://localhost:8787",
    databasePath: env.DEVHUB_DB ?? "devhub.db",
    adminToken: env.DEVHUB_ADMIN_TOKEN,
    auth: {
      devLogin: env.DEVHUB_DEV_LOGIN === "true",
      jitProvisioning: true,
      allowedEmailDomains: [],
    },
    wallet: { defaultMonthlyBudgetUsd: 300, warnAt: 0.8 },
    connectors: {},
    syncIntervalSeconds: 300,
    notify: { slackWebhookUrl: env.DEVHUB_SLACK_WEBHOOK_URL },
  };

  const cfg: Config = {
    ...base,
    ...fromFile,
    ...overrides,
    auth: { ...base.auth, ...fromFile.auth, ...overrides.auth },
    wallet: { ...base.wallet, ...fromFile.wallet, ...overrides.wallet },
    connectors: { ...base.connectors, ...fromFile.connectors, ...overrides.connectors },
    notify: { ...base.notify, ...fromFile.notify, ...overrides.notify },
  };

  // Env vars fill in only what the file and explicit overrides left unset.
  if (!cfg.auth.oidc && env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET) {
    cfg.auth.oidc = {
      issuer: env.OIDC_ISSUER,
      clientId: env.OIDC_CLIENT_ID,
      clientSecret: env.OIDC_CLIENT_SECRET,
      adminGroup: env.OIDC_ADMIN_GROUP,
      groupsClaim: env.OIDC_GROUPS_CLAIM ?? "groups",
    };
  }
  if (!cfg.connectors.claude && env.CLAUDE_ADMIN_KEY && env.CLAUDE_ADMIN_BASE_URL) {
    cfg.connectors.claude = {
      mode: (env.CLAUDE_MODE as "gateway" | "enterprise") ?? "gateway",
      baseUrl: env.CLAUDE_ADMIN_BASE_URL,
      apiKey: env.CLAUDE_ADMIN_KEY,
      enforceCaps: env.CLAUDE_ENFORCE_CAPS !== "false",
    };
  }
  if (!cfg.connectors.copilot && env.GITHUB_TOKEN && env.GITHUB_ORG) {
    cfg.connectors.copilot = {
      org: env.GITHUB_ORG,
      token: env.GITHUB_TOKEN,
      apiUrl: env.GITHUB_API_URL ?? "https://api.github.com",
      seatPriceUsd: { business: 19, enterprise: 39 },
    };
  }
  // Secrets can stay out of the config file: fill them from env when the file omits them.
  if (cfg.auth.oidc && !cfg.auth.oidc.clientSecret) cfg.auth.oidc.clientSecret = env.OIDC_CLIENT_SECRET ?? "";
  if (cfg.connectors.claude && !cfg.connectors.claude.apiKey) cfg.connectors.claude.apiKey = env.CLAUDE_ADMIN_KEY ?? "";
  if (cfg.connectors.copilot && !cfg.connectors.copilot.token) cfg.connectors.copilot.token = env.GITHUB_TOKEN ?? "";
  if (cfg.connectors.copilot) {
    cfg.connectors.copilot.apiUrl ??= "https://api.github.com";
    cfg.connectors.copilot.seatPriceUsd ??= { business: 19, enterprise: 39 };
  }
  return cfg;
}
