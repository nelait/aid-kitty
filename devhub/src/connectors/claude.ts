import type { ClaudeConnectorConfig } from "../config.js";
import type { User } from "../db.js";
import { fetchJson, type CapEnforcer, type Connector, type SpendRow } from "./types.js";

const API_VERSION = "2026-10-21";

interface SpendSummary {
  scope?: { type: string; user_id?: string };
  period: string;
  amount: string | null;
  currency: string;
  period_to_date_spend: string;
}

/**
 * Claude spend through either a self-hosted Claude apps gateway or the Claude
 * Enterprise Admin API. Both serve the same spend-limits API shape:
 *   GET  /v1/organizations/spend_limits/effective  (period-to-date spend per member)
 *   POST /v1/organizations/spend_limits            (upsert a per-user cap)
 */
export class ClaudeConnector implements Connector, CapEnforcer {
  tool = "claude";

  constructor(private cfg: ClaudeConnectorConfig) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "anthropic-version": API_VERSION,
      "content-type": "application/json",
    };
    // The gateway authenticates admin keys via x-api-key; Enterprise scoped keys via bearer.
    if (this.cfg.mode === "gateway") h["x-api-key"] = this.cfg.apiKey;
    else h["authorization"] = `Bearer ${this.cfg.apiKey}`;
    return h;
  }

  externalIdFor(user: User): string | null {
    if (this.cfg.mode === "gateway") return user.claude_user_id ?? user.oidc_sub;
    return user.claude_user_id;
  }

  async fetchMonthlySpend(): Promise<SpendRow[]> {
    const rows: SpendRow[] = [];
    let page: string | null = null;
    do {
      const url = new URL("/v1/organizations/spend_limits/effective", this.cfg.baseUrl);
      url.searchParams.append("period[]", "monthly");
      url.searchParams.set("limit", "1000");
      if (page) url.searchParams.set("page", page);
      const body = (await fetchJson("claude", url.toString(), { headers: this.headers() })) as {
        data: SpendSummary[];
        next_page: string | null;
      };
      for (const s of body.data ?? []) {
        if (s.period !== "monthly" || !s.scope?.user_id) continue;
        if (s.currency && s.currency !== "USD") {
          throw new Error(`claude: unsupported billing currency ${s.currency}`);
        }
        rows.push({ externalId: s.scope.user_id, cents: Math.round(Number(s.period_to_date_spend)) });
      }
      page = body.next_page ?? null;
    } while (page);
    return rows;
  }

  async setMonthlyCap(externalId: string, cents: number): Promise<void> {
    await fetchJson("claude", new URL("/v1/organizations/spend_limits", this.cfg.baseUrl).toString(), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        scope: { type: "user", user_id: externalId },
        amount: String(Math.max(0, Math.floor(cents))),
        currency: "USD",
        period: "monthly",
      }),
    });
  }
}
