import type { Db } from "./db.js";
import { previousPeriod } from "./output.js";

/**
 * Return on spend: AI spend (every tool) next to merged pull requests, by team and month.
 *
 * PR counts are a rough output signal, not a productivity measure: PR size and difficulty
 * vary, and spend isn't the only thing that changes output. The report says so, keeps team
 * and org views up front, and only counts PRs by people whose GitHub login is known.
 */

export interface RoiRow {
  spendCents: number;
  mergedPrs: number;
  /**
   * Spend per merged PR, using only the spend of people whose PRs are counted (those with a
   * GitHub login), so unlinked spend doesn't inflate it. null when there are no PRs.
   */
  centsPerPr: number | null;
}

export interface RoiTeam extends RoiRow {
  team: string;
  costCenter: string | null;
  people: number;
  /** Share of all attributed spend and of all attributed PRs, 0-1. */
  spendShare: number;
  prShare: number;
}

export interface RoiPerson extends RoiRow {
  email: string;
  team: string | null;
  githubLogin: string | null;
}

export interface RoiReport {
  period: string;
  org: RoiRow & {
    /** All merged PRs in the GitHub org that month, including people outside Dev Hub and bots. */
    orgMergedPrs: number | null;
    claudeMarkedPrs: number | null;
    spendingPeople: number;
    /** People with spend this month but no GitHub login, whose PRs can't be counted. */
    unlinkedSpenders: number;
    unlinkedSpendCents: number;
  };
  teams: RoiTeam[];
  people: RoiPerson[];
  trend: (RoiRow & { period: string; orgMergedPrs: number | null })[];
}

const row = (spendCents: number, mergedPrs: number, linkedSpendCents = spendCents): RoiRow => ({
  spendCents,
  mergedPrs,
  centsPerPr: mergedPrs > 0 ? Math.round(linkedSpendCents / mergedPrs) : null,
});

async function orgMetric(db: Db, period: string, metric: string): Promise<number | null> {
  const r = await db.get<{ value: number }>("SELECT value FROM output_metrics WHERE period = ? AND subject = 'org' AND metric = ?", period, metric);
  return r ? Number(r.value) : null;
}

export async function roiReport(db: Db, period: string, trendMonths = 6): Promise<RoiReport> {
  const people = await db.all<{
    id: number;
    email: string;
    github_login: string | null;
    team: string | null;
    cost_center: string | null;
    spend: number;
    prs: number | null;
  }>(
    `SELECT u.id, u.email, u.github_login, t.name AS team, t.cost_center,
       COALESCE((SELECT SUM(s.cents) FROM spend s WHERE s.user_id = u.id AND s.period = ?), 0) AS spend,
       (SELECT o.value FROM output_metrics o WHERE o.period = ? AND o.subject = 'user:' || u.id AND o.metric = 'merged_prs') AS prs
     FROM users u LEFT JOIN teams t ON t.id = u.team_id
     ORDER BY u.email`,
    period,
    period,
  );

  const rows = people
    .map((p) => ({ ...p, spend: Number(p.spend), prs: p.prs === null ? 0 : Number(p.prs) }))
    .filter((p) => p.spend > 0 || p.prs > 0);

  const totalSpend = rows.reduce((a, p) => a + p.spend, 0);
  const linkedSpend = rows.filter((p) => p.github_login).reduce((a, p) => a + p.spend, 0);
  const totalPrs = rows.reduce((a, p) => a + p.prs, 0);
  const unlinked = rows.filter((p) => p.spend > 0 && !p.github_login);

  const byTeam = new Map<string, { costCenter: string | null; spend: number; linked: number; prs: number; people: number }>();
  for (const p of rows) {
    const key = p.team ?? "(no team)";
    const t = byTeam.get(key) ?? { costCenter: p.cost_center, spend: 0, linked: 0, prs: 0, people: 0 };
    t.spend += p.spend;
    if (p.github_login) t.linked += p.spend;
    t.prs += p.prs;
    t.people++;
    byTeam.set(key, t);
  }
  const teams: RoiTeam[] = [...byTeam]
    .map(([team, t]) => ({
      team,
      costCenter: t.costCenter,
      people: t.people,
      ...row(t.spend, t.prs, t.linked),
      spendShare: totalSpend ? t.spend / totalSpend : 0,
      prShare: totalPrs ? t.prs / totalPrs : 0,
    }))
    .sort((a, b) => b.spendCents - a.spendCents);

  const trend: RoiReport["trend"] = [];
  let p = period;
  for (let i = 0; i < trendMonths; i++) {
    const s = await db.get<{ c: number; linked: number }>(
      `SELECT COALESCE(SUM(s.cents), 0) AS c,
              COALESCE(SUM(CASE WHEN u.github_login IS NOT NULL THEN s.cents ELSE 0 END), 0) AS linked
       FROM spend s JOIN users u ON u.id = s.user_id WHERE s.period = ?`,
      p,
    );
    const prs = await db.get<{ c: number }>(
      "SELECT COALESCE(SUM(value), 0) AS c FROM output_metrics WHERE period = ? AND metric = 'merged_prs' AND subject LIKE 'user:%'",
      p,
    );
    trend.unshift({ period: p, ...row(Number(s!.c), Number(prs!.c), Number(s!.linked)), orgMergedPrs: await orgMetric(db, p, "merged_prs") });
    p = previousPeriod(p);
  }

  return {
    period,
    org: {
      ...row(totalSpend, totalPrs, linkedSpend),
      orgMergedPrs: await orgMetric(db, period, "merged_prs"),
      claudeMarkedPrs: await orgMetric(db, period, "claude_marked_prs"),
      spendingPeople: rows.filter((r) => r.spend > 0).length,
      unlinkedSpenders: unlinked.length,
      unlinkedSpendCents: unlinked.reduce((a, r) => a + r.spend, 0),
    },
    teams,
    people: rows
      .map((r) => ({ email: r.email, team: r.team, githubLogin: r.github_login, ...row(r.spend, r.prs, r.github_login ? r.spend : 0) }))
      .sort((a, b) => b.spendCents - a.spendCents),
    trend,
  };
}

export function roiCsv(r: RoiReport): string {
  const usd = (c: number | null) => (c === null ? "" : (c / 100).toFixed(2));
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = ["level,name,team,spend_usd,merged_prs,usd_per_merged_pr"];
  lines.push(["org", "all", "", usd(r.org.spendCents), r.org.mergedPrs, usd(r.org.centsPerPr)].map(cell).join(","));
  for (const t of r.teams) lines.push(["team", t.team, t.team, usd(t.spendCents), t.mergedPrs, usd(t.centsPerPr)].map(cell).join(","));
  for (const p of r.people) lines.push(["person", p.email, p.team ?? "", usd(p.spendCents), p.mergedPrs, usd(p.centsPerPr)].map(cell).join(","));
  return lines.join("\n") + "\n";
}
