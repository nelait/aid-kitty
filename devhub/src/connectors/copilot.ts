import type { CopilotConnectorConfig } from "../config.js";
import type { User } from "../db.js";
import { usdToCents } from "../wallet.js";
import { fetchJson, type Connector, type SpendRow } from "./types.js";

interface Seat {
  assignee?: { login?: string } | null;
  plan_type?: string;
  pending_cancellation_date?: string | null;
}

/**
 * GitHub Copilot seats for an organization, priced per seat per month.
 * Premium-request overage is not included yet (roadmap).
 */
export class CopilotConnector implements Connector {
  tool = "copilot";

  constructor(private cfg: CopilotConnectorConfig) {}

  externalIdFor(user: User): string | null {
    return user.github_login;
  }

  async fetchMonthlySpend(): Promise<SpendRow[]> {
    const rows: SpendRow[] = [];
    for (let page = 1; ; page++) {
      const url = `${this.cfg.apiUrl}/orgs/${encodeURIComponent(this.cfg.org)}/copilot/billing/seats?per_page=100&page=${page}`;
      const body = (await fetchJson("copilot", url, {
        headers: {
          authorization: `Bearer ${this.cfg.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      })) as { seats?: Seat[] };
      const seats = body.seats ?? [];
      for (const s of seats) {
        const login = s.assignee?.login;
        if (!login) continue;
        const plan = s.plan_type ?? "business";
        const price = this.cfg.seatPriceUsd[plan] ?? this.cfg.seatPriceUsd["business"] ?? 0;
        rows.push({ externalId: login.toLowerCase(), cents: usdToCents(price) });
      }
      if (seats.length < 100) break;
    }
    return rows;
  }
}
