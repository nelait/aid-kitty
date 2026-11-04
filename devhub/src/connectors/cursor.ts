import type { CursorConnectorConfig } from "../config.js";
import type { User } from "../db.js";
import { ConnectorError, fetchJson, type Connector, type SpendRow } from "./types.js";

interface MemberSpend {
  email?: unknown;
  spendCents?: unknown;
}

/**
 * Cursor team spend from the Cursor Admin API (POST /teams/spend, Basic auth with the
 * admin API key as the username). Members are matched by email.
 *
 * Cursor reports spend for the team's billing cycle, which may not start on the 1st;
 * Dev Hub treats it as this month's spend. Shape not yet verified against a live team,
 * so any unexpected field fails the pull loudly instead of recording wrong numbers.
 */
export class CursorConnector implements Connector {
  tool = "cursor";

  constructor(private cfg: CursorConnectorConfig) {}

  externalIdFor(user: User): string | null {
    return user.email;
  }

  normalizeId(id: string): string {
    return id.toLowerCase();
  }

  async fetchMonthlySpend(): Promise<SpendRow[]> {
    const rows: SpendRow[] = [];
    const auth = "Basic " + Buffer.from(`${this.cfg.apiKey}:`).toString("base64");
    for (let page = 1; page <= 1000; page++) {
      const body = (await fetchJson("cursor", `${this.cfg.apiUrl}/teams/spend`, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ page, pageSize: 100 }),
      })) as { teamMemberSpend?: MemberSpend[]; totalPages?: unknown };
      if (!Array.isArray(body?.teamMemberSpend)) {
        throw new ConnectorError("cursor", "response has no teamMemberSpend array");
      }
      for (const m of body.teamMemberSpend) {
        if (typeof m.email !== "string" || typeof m.spendCents !== "number" || !Number.isFinite(m.spendCents)) {
          throw new ConnectorError("cursor", "teamMemberSpend item without email/spendCents");
        }
        rows.push({ externalId: m.email.toLowerCase(), cents: Math.round(m.spendCents) });
      }
      const totalPages = typeof body.totalPages === "number" ? body.totalPages : 1;
      if (page >= totalPages || body.teamMemberSpend.length === 0) break;
    }
    return rows;
  }
}
