import type { Config } from "./config.js";
import { audit, nowIso, type Db, type User } from "./db.js";
import { slack, type EmailSender } from "./notify.js";
import { currentPeriod, fmtUsd, walletFor, type WalletStatus } from "./wallet.js";

/**
 * Budget heads-up: email a person when their whole AI budget (every tool) passes the
 * warning threshold (cfg.wallet.warnAt, default 80%) and again when it is used up.
 * At 100% their team's managers are emailed too, and Slack gets a line if configured.
 *
 * Each level fires once per person per month. If an approved increase brings them back
 * under a level, that level re-arms, so they hear about it again if they pass it later.
 */

type Level = "warning" | "exhausted";

const monthName = (period: string) =>
  new Date(`${period}-01T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

const nextReset = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
};

function levelsFor(cfg: Config, w: WalletStatus): Level[] {
  if (w.limitCents <= 0) return [];
  if (w.state === "exhausted") return ["warning", "exhausted"];
  return w.spendCents / w.limitCents >= cfg.wallet.warnAt ? ["warning"] : [];
}

function breakdown(w: WalletStatus): string {
  return Object.entries(w.spendByTool)
    .sort((a, b) => b[1] - a[1])
    .map(([tool, cents]) => `  ${tool}: ${fmtUsd(cents)}`)
    .join("\n");
}

function personEmail(cfg: Config, u: User, w: WalletStatus, level: Level) {
  const pct = Math.round((w.spendCents / w.limitCents) * 100);
  const month = monthName(w.period);
  const ask = `Need more? Ask for an increase in Dev Hub: ${cfg.publicUrl}/`;
  if (level === "warning") {
    return {
      subject: `You've used ${pct}% of your AI budget for ${month}`,
      text: [
        `Hi ${u.name ?? u.email},`,
        "",
        `You've spent ${fmtUsd(w.spendCents)} of your ${fmtUsd(w.limitCents)} AI budget for ${month}. ${fmtUsd(w.remainingCents)} is left.`,
        "",
        breakdown(w),
        "",
        `When it runs out, Claude requests are blocked until the budget resets on ${nextReset(w.period)}.`,
        ask,
      ].join("\n"),
    };
  }
  return {
    subject: `Your AI budget for ${month} is used up`,
    text: [
      `Hi ${u.name ?? u.email},`,
      "",
      `You've spent ${fmtUsd(w.spendCents)} of your ${fmtUsd(w.limitCents)} AI budget for ${month}` +
        (w.team?.poolCents != null && w.team.spendCents >= w.team.poolCents ? `, and team ${w.team.name} has used its shared pool.` : "."),
      "",
      breakdown(w),
      "",
      `Claude requests are blocked until the budget resets on ${nextReset(w.period)} or an increase is approved.`,
      ask,
    ].join("\n"),
  };
}

export class BudgetAlerts {
  constructor(
    private db: Db,
    private cfg: Config,
    private email: EmailSender,
  ) {}

  /** Check everyone (or the given people) and send any alerts that are due. Returns how many went out. */
  async check(onlyUserIds?: number[]): Promise<number> {
    if (this.cfg.notify.budgetAlerts === false) return 0;
    const period = currentPeriod();
    let users = await this.db.all<User>("SELECT * FROM users WHERE status = 'active' AND deleted_at IS NULL");
    if (onlyUserIds) users = users.filter((u) => onlyUserIds.includes(u.id));
    let sent = 0;
    for (const u of users) {
      const w = await walletFor(this.db, this.cfg, u, period);
      const due = levelsFor(this.cfg, w);
      // Re-arm levels the person is back under (e.g. after an approved increase).
      const rearm = (["warning", "exhausted"] as Level[]).filter((l) => !due.includes(l));
      for (const l of rearm) await this.db.run("DELETE FROM budget_alerts WHERE user_id = ? AND period = ? AND level = ?", u.id, period, l);

      // Only the highest new level is announced: someone jumping from 50% to 100% gets one email.
      const fresh: Level[] = [];
      for (const level of due) {
        const claimed = await this.db.run(
          "INSERT INTO budget_alerts (user_id, period, level, sent_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, period, level) DO NOTHING",
          u.id,
          period,
          level,
          nowIso(),
        );
        if (claimed.changes > 0) fresh.push(level);
      }
      if (fresh.length === 0) continue;
      const level: Level = fresh.includes("exhausted") ? "exhausted" : "warning";
      try {
        await this.email.send({ to: [u.email], ...personEmail(this.cfg, u, w, level) });
        if (level === "exhausted") await this.tellManagers(u, w);
        await audit(this.db, "system", `budget.alert.${level}`, { user: u.email, period, spendCents: w.spendCents, limitCents: w.limitCents });
        sent++;
      } catch (e) {
        // Let the next check retry rather than silently dropping the alert.
        for (const l of fresh) await this.db.run("DELETE FROM budget_alerts WHERE user_id = ? AND period = ? AND level = ?", u.id, period, l);
        console.error(`budget alert to ${u.email} failed:`, (e as Error).message);
      }
    }
    return sent;
  }

  private async tellManagers(u: User, w: WalletStatus) {
    const month = monthName(w.period);
    slack(this.cfg, `${u.email} has used their ${fmtUsd(w.limitCents)} AI budget for ${month}. Claude is blocked for them until it resets or an increase is approved.`);
    if (u.team_id === null) return;
    const managers = await this.db.all<{ email: string }>(
      "SELECT email FROM users WHERE team_id = ? AND role = 'manager' AND status = 'active' AND deleted_at IS NULL AND id != ?",
      u.team_id,
      u.id,
    );
    if (managers.length === 0) return;
    await this.email.send({
      to: managers.map((m) => m.email),
      subject: `${u.name ?? u.email} has used their AI budget for ${month}`,
      text: [
        `${u.name ?? u.email} (${u.email}) has spent ${fmtUsd(w.spendCents)} of a ${fmtUsd(w.limitCents)} AI budget for ${month}.`,
        "",
        breakdown(w),
        "",
        `Claude requests are blocked for them until ${nextReset(w.period)} or an increase is approved.`,
        `If they ask for more, you can approve it here: ${this.cfg.publicUrl}/approvals`,
      ].join("\n"),
    });
  }
}
