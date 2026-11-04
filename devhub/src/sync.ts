import type { Config } from "./config.js";
import { ClaudeConnector } from "./connectors/claude.js";
import { CopilotConnector } from "./connectors/copilot.js";
import type { Connector } from "./connectors/types.js";
import { audit, nowIso, tx, type Db, type User } from "./db.js";
import { currentPeriod, walletFor } from "./wallet.js";

export interface SyncResult {
  connector: string;
  ok: boolean;
  message: string;
}

export class SyncService {
  readonly connectors: Connector[] = [];
  readonly claude?: ClaudeConnector;
  private running: Promise<SyncResult[]> | null = null;

  constructor(
    private db: Db,
    private cfg: Config,
    extra: Connector[] = [],
  ) {
    if (cfg.connectors.claude) {
      this.claude = new ClaudeConnector(cfg.connectors.claude);
      this.connectors.push(this.claude);
    }
    if (cfg.connectors.copilot) this.connectors.push(new CopilotConnector(cfg.connectors.copilot));
    this.connectors.push(...extra);
  }

  /** Pull spend from every connector, then push updated Claude caps. Concurrent calls share one run. */
  run(): Promise<SyncResult[]> {
    this.running ??= this.doRun().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doRun(): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    for (const c of this.connectors) {
      try {
        const rows = await c.fetchMonthlySpend();
        const { matched, unmatched } = this.storeSpend(c, rows);
        results.push({ connector: c.tool, ok: true, message: `${matched} users matched, ${unmatched} unmatched` });
      } catch (e) {
        // Keep the previous spend for this tool rather than zeroing it on a failed pull.
        results.push({ connector: c.tool, ok: false, message: (e as Error).message });
      }
    }
    // Only enforce caps from fresh data: if any pull failed, the wallet could be understated.
    if (this.claude && this.cfg.connectors.claude?.enforceCaps) {
      if (results.every((r) => r.ok)) {
        try {
          const n = await this.pushCaps();
          results.push({ connector: "claude-caps", ok: true, message: `${n} caps updated` });
        } catch (e) {
          results.push({ connector: "claude-caps", ok: false, message: (e as Error).message });
        }
      } else {
        results.push({ connector: "claude-caps", ok: false, message: "skipped: a spend pull failed" });
      }
    }
    const ins = this.db.prepare("INSERT INTO sync_runs (ts, connector, ok, message) VALUES (?, ?, ?, ?)");
    for (const r of results) ins.run(nowIso(), r.connector, r.ok ? 1 : 0, r.message);
    return results;
  }

  private storeSpend(c: Connector, rows: { externalId: string; cents: number }[]) {
    const period = currentPeriod();
    const users = this.db.prepare("SELECT * FROM users").all() as unknown as User[];
    const byExternal = new Map<string, User>();
    for (const u of users) {
      const id = c.externalIdFor(u);
      if (id) byExternal.set(c.tool === "copilot" ? id.toLowerCase() : id, u);
    }

    // Aggregate first: a vendor may report several rows for one identity.
    const perUser = new Map<number, number>();
    const unmatched = new Map<string, number>();
    for (const r of rows) {
      const u = byExternal.get(c.tool === "copilot" ? r.externalId.toLowerCase() : r.externalId);
      if (u) perUser.set(u.id, (perUser.get(u.id) ?? 0) + r.cents);
      else unmatched.set(r.externalId, (unmatched.get(r.externalId) ?? 0) + r.cents);
    }

    const ts = nowIso();
    tx(this.db, () => {
      this.db.prepare("DELETE FROM spend WHERE period = ? AND tool = ?").run(period, c.tool);
      this.db.prepare("DELETE FROM unmatched_spend WHERE period = ? AND tool = ?").run(period, c.tool);
      const ins = this.db.prepare("INSERT INTO spend (period, user_id, tool, cents, synced_at) VALUES (?, ?, ?, ?, ?)");
      for (const [uid, cents] of perUser) ins.run(period, uid, c.tool, cents, ts);
      const insU = this.db.prepare(
        "INSERT INTO unmatched_spend (period, tool, external_id, cents, synced_at) VALUES (?, ?, ?, ?, ?)",
      );
      for (const [ext, cents] of unmatched) insU.run(period, c.tool, ext, cents, ts);
    });
    return { matched: perUser.size, unmatched: unmatched.size };
  }

  /**
   * Set each user's Claude monthly cap to (Claude spend so far + what is left in their wallet),
   * so total spend across every tool stays inside the wallet. Writes only caps that changed.
   */
  async pushCaps(onlyUserIds?: number[]): Promise<number> {
    if (!this.claude) return 0;
    const period = currentPeriod();
    let users = this.db.prepare("SELECT * FROM users").all() as unknown as User[];
    if (onlyUserIds) users = users.filter((u) => onlyUserIds.includes(u.id));
    const last = this.db.prepare("SELECT period, cents FROM claude_caps WHERE user_id = ?");
    const save = this.db.prepare(
      "INSERT INTO claude_caps (user_id, period, cents, pushed_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(user_id) DO UPDATE SET period = excluded.period, cents = excluded.cents, pushed_at = excluded.pushed_at",
    );
    let changed = 0;
    for (const u of users) {
      const ext = this.claude.externalIdFor(u);
      if (!ext) continue;
      const cap = walletFor(this.db, this.cfg, u, period).claudeCapCents;
      const prev = last.get(u.id) as { period: string; cents: number } | undefined;
      if (prev && prev.period === period && Number(prev.cents) === cap) continue;
      await this.claude.setMonthlyCap(ext, cap);
      save.run(u.id, period, cap, nowIso());
      audit(this.db, "system", "claude.cap.set", { user: u.email, cents: cap, period });
      changed++;
    }
    return changed;
  }

  start(): () => void {
    const tick = () => {
      this.run().catch((e) => console.error("sync failed", e));
    };
    tick();
    const t = setInterval(tick, this.cfg.syncIntervalSeconds * 1000);
    t.unref();
    return () => clearInterval(t);
  }
}
