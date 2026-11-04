import type { CopilotConnectorConfig } from "../config.js";
import type { User } from "../db.js";
import { usdToCents } from "../wallet.js";
import { ConnectorError, fetchJson, type Connector, type SpendRow } from "./types.js";

interface Seat {
  assignee?: { login?: string } | null;
  plan_type?: string;
}

interface PremiumUsage {
  usageItems?: { product?: string; netAmount?: number }[];
}

/**
 * GitHub Copilot for one organization: each seat at its monthly plan price, plus
 * premium-request overage per user from GitHub's billing usage API
 * (GET /organizations/{org}/settings/billing/premium_request/usage?user=...).
 *
 * That API only breaks usage down per user when filtered by `user`, so it costs one
 * call per seat. Results are cached and refreshed every `premiumRefreshMinutes`.
 */
export class CopilotConnector implements Connector {
  tool = "copilot";
  private premiumCache = new Map<string, { cents: number; at: number }>();

  constructor(
    private cfg: CopilotConnectorConfig,
    private now: () => number = Date.now,
  ) {}

  externalIdFor(user: User): string | null {
    return user.github_login;
  }

  normalizeId(id: string): string {
    return id.toLowerCase();
  }

  private headers() {
    return {
      authorization: `Bearer ${this.cfg.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    };
  }

  async fetchMonthlySpend(): Promise<SpendRow[]> {
    const rows: SpendRow[] = [];
    const logins: string[] = [];
    for (let page = 1; ; page++) {
      const url = `${this.cfg.apiUrl}/orgs/${encodeURIComponent(this.cfg.org)}/copilot/billing/seats?per_page=100&page=${page}`;
      const body = (await fetchJson("copilot", url, { headers: this.headers() })) as { seats?: Seat[] };
      const seats = body.seats ?? [];
      for (const s of seats) {
        const login = s.assignee?.login;
        if (!login) continue;
        const plan = s.plan_type ?? "business";
        const price = this.cfg.seatPriceUsd[plan] ?? this.cfg.seatPriceUsd["business"] ?? 0;
        rows.push({ externalId: login.toLowerCase(), cents: usdToCents(price) });
        logins.push(login.toLowerCase());
      }
      if (seats.length < 100) break;
    }

    if (this.cfg.premiumRequests !== false) {
      const overage = await this.premiumOverage(logins);
      for (const [login, cents] of overage) if (cents > 0) rows.push({ externalId: login, cents });
    }
    return rows;
  }

  /** Net premium-request charges this month (after the plan's included allowance), per login. */
  private async premiumOverage(logins: string[]): Promise<Map<string, number>> {
    const d = new Date(this.now());
    const period = d.toISOString().slice(0, 7);
    const maxAge = (this.cfg.premiumRefreshMinutes ?? 60) * 60_000;
    const out = new Map<string, number>();
    const stale: string[] = [];
    for (const login of logins) {
      const hit = this.premiumCache.get(`${period}:${login}`);
      if (hit && this.now() - hit.at < maxAge) out.set(login, hit.cents);
      else stale.push(login);
    }

    // A few requests at a time keeps well inside GitHub's rate limits for large orgs.
    const queue = [...stale];
    const worker = async () => {
      for (let login = queue.shift(); login !== undefined; login = queue.shift()) {
        const url = new URL(`${this.cfg.apiUrl}/organizations/${encodeURIComponent(this.cfg.org)}/settings/billing/premium_request/usage`);
        url.searchParams.set("year", String(d.getUTCFullYear()));
        url.searchParams.set("month", String(d.getUTCMonth() + 1));
        url.searchParams.set("user", login);
        const body = (await fetchJson("copilot", url.toString(), { headers: this.headers() })) as PremiumUsage;
        if (!Array.isArray(body?.usageItems)) {
          throw new ConnectorError("copilot", "premium request usage response has no usageItems array");
        }
        const usd = body.usageItems
          .filter((i) => /copilot/i.test(i.product ?? ""))
          .reduce((sum, i) => sum + (Number.isFinite(i.netAmount) ? Number(i.netAmount) : 0), 0);
        const cents = usdToCents(usd);
        this.premiumCache.set(`${period}:${login}`, { cents, at: this.now() });
        out.set(login, cents);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, stale.length) }, worker));
    return out;
  }
}
