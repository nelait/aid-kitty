import type { Config } from "./config.js";
import { getTeam, type Db, type User } from "./db.js";

/** Calendar month in UTC, "YYYY-MM" (matches the Claude spend-limit reset boundary). */
export function currentPeriod(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}

export const usdToCents = (usd: number): number => Math.round(usd * 100);
export const fmtUsd = (cents: number): string =>
  (cents < 0 ? "-$" : "$") +
  (Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface WalletStatus {
  period: string;
  baseBudgetCents: number;
  approvedRaisesCents: number;
  limitCents: number;
  spendByTool: Record<string, number>;
  spendCents: number;
  team?: { name: string; poolCents: number | null; spendCents: number };
  /** What the user can still spend this period, after both personal and team limits. */
  remainingCents: number;
  /** Cap to set on Claude so total spend across all tools stays inside the wallet. */
  claudeCapCents: number;
  state: "ok" | "warning" | "exhausted";
}

export function baseBudgetCents(db: Db, cfg: Config, user: User): number {
  if (user.monthly_budget_cents !== null) return user.monthly_budget_cents;
  const team = getTeam(db, user.team_id);
  if (team?.member_default_cents != null) return team.member_default_cents;
  return usdToCents(cfg.wallet.defaultMonthlyBudgetUsd);
}

export function walletFor(db: Db, cfg: Config, user: User, period = currentPeriod()): WalletStatus {
  const base = user.status === "active" ? baseBudgetCents(db, cfg, user) : 0;
  const raises =
    user.status === "active"
      ? Number(
          (
            db
              .prepare(
                "SELECT COALESCE(SUM(amount_cents),0) AS c FROM raise_requests WHERE user_id = ? AND period = ? AND status = 'approved'",
              )
              .get(user.id, period) as { c: number }
          ).c,
        )
      : 0;

  const rows = db
    .prepare("SELECT tool, cents FROM spend WHERE user_id = ? AND period = ?")
    .all(user.id, period) as { tool: string; cents: number }[];
  const spendByTool: Record<string, number> = {};
  for (const r of rows) spendByTool[r.tool] = Number(r.cents);
  const spend = Object.values(spendByTool).reduce((a, b) => a + b, 0);

  const limit = base + raises;
  let remaining = limit - spend;

  let teamInfo: WalletStatus["team"];
  const team = getTeam(db, user.team_id);
  if (team) {
    const teamSpend = Number(
      (
        db
          .prepare(
            "SELECT COALESCE(SUM(s.cents),0) AS c FROM spend s JOIN users u ON u.id = s.user_id WHERE u.team_id = ? AND s.period = ?",
          )
          .get(team.id, period) as { c: number }
      ).c,
    );
    teamInfo = { name: team.name, poolCents: team.monthly_pool_cents, spendCents: teamSpend };
    if (team.monthly_pool_cents !== null) {
      remaining = Math.min(remaining, team.monthly_pool_cents - teamSpend);
    }
  }
  remaining = Math.max(0, remaining);

  const claudeSpend = spendByTool["claude"] ?? 0;
  const claudeCap = user.status === "active" ? claudeSpend + remaining : 0;

  const utilization = limit > 0 ? spend / limit : 1;
  const state: WalletStatus["state"] =
    remaining <= 0 ? "exhausted" : utilization >= cfg.wallet.warnAt ? "warning" : "ok";

  return {
    period,
    baseBudgetCents: base,
    approvedRaisesCents: raises,
    limitCents: limit,
    spendByTool,
    spendCents: spend,
    team: teamInfo,
    remainingCents: remaining,
    claudeCapCents: claudeCap,
    state,
  };
}
