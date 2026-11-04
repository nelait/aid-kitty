import type { Config } from "./config.js";
import { ClaudeConnector } from "./connectors/claude.js";
import { CopilotConnector } from "./connectors/copilot.js";
import { CursorConnector } from "./connectors/cursor.js";
import type { Connector } from "./connectors/types.js";
import { randomUUID } from "node:crypto";
import { BudgetAlerts } from "./alerts.js";
import { emailSender, type EmailSender } from "./notify.js";
import { OutputService } from "./output.js";
import type { WorkspaceProvider } from "./providers/types.js";
import { WorkspacesConnector, WorkspaceService } from "./workspaces.js";
import { audit, nowIso, type Db, type User } from "./db.js";
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
  readonly alerts: BudgetAlerts;
  readonly output: OutputService;
  readonly workspaces: WorkspaceService;

  constructor(
    private db: Db,
    private cfg: Config,
    extra: Connector[] = [],
    email: EmailSender = emailSender(cfg),
    /** workspaceProviders replaces the configured backends (tests pass fakes). */
    opts: { workspaceProviders?: WorkspaceProvider[]; now?: () => number } = {},
  ) {
    this.workspaces = new WorkspaceService(db, cfg, opts.workspaceProviders, opts.now);
    if (this.workspaces.enabled) this.connectors.push(new WorkspacesConnector(this.workspaces));
    this.alerts = new BudgetAlerts(db, cfg, email);
    this.output = new OutputService(db, cfg);
    if (cfg.connectors.claude) {
      this.claude = new ClaudeConnector(cfg.connectors.claude);
      this.connectors.push(this.claude);
    }
    if (cfg.connectors.copilot) this.connectors.push(new CopilotConnector(cfg.connectors.copilot));
    if (cfg.connectors.cursor) this.connectors.push(new CursorConnector(cfg.connectors.cursor));
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
        const { matched, unmatched } = await this.storeSpend(c, rows);
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
    try {
      const n = await this.alerts.check();
      if (n > 0) results.push({ connector: "budget-alerts", ok: true, message: `${n} sent` });
    } catch (e) {
      results.push({ connector: "budget-alerts", ok: false, message: (e as Error).message });
    }
    for (const r of results) {
      await this.db.run("INSERT INTO sync_runs (ts, connector, ok, message) VALUES (?, ?, ?, ?)", nowIso(), r.connector, r.ok ? 1 : 0, r.message);
    }
    return results;
  }

  private async storeSpend(c: Connector, rows: { externalId: string; cents: number }[]) {
    const period = currentPeriod();
    const users = await this.db.all<User>("SELECT * FROM users");
    const norm = (id: string) => (c.normalizeId ? c.normalizeId(id) : id);
    const byExternal = new Map<string, User>();
    for (const u of users) {
      const id = c.externalIdFor(u);
      if (id) byExternal.set(norm(id), u);
    }

    // Aggregate first: a vendor may report several rows for one identity.
    const perUser = new Map<number, number>();
    const unmatched = new Map<string, number>();
    for (const r of rows) {
      const u = byExternal.get(norm(r.externalId));
      if (u) perUser.set(u.id, (perUser.get(u.id) ?? 0) + r.cents);
      else unmatched.set(r.externalId, (unmatched.get(r.externalId) ?? 0) + r.cents);
    }

    const ts = nowIso();
    await this.db.tx(async (q) => {
      await q.run("DELETE FROM spend WHERE period = ? AND tool = ?", period, c.tool);
      await q.run("DELETE FROM unmatched_spend WHERE period = ? AND tool = ?", period, c.tool);
      for (const [uid, cents] of perUser) {
        await q.run("INSERT INTO spend (period, user_id, tool, cents, synced_at) VALUES (?, ?, ?, ?, ?)", period, uid, c.tool, cents, ts);
      }
      for (const [ext, cents] of unmatched) {
        await q.run(
          "INSERT INTO unmatched_spend (period, tool, external_id, cents, synced_at) VALUES (?, ?, ?, ?, ?)",
          period,
          c.tool,
          ext,
          cents,
          ts,
        );
      }
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
    let users = await this.db.all<User>("SELECT * FROM users");
    if (onlyUserIds) users = users.filter((u) => onlyUserIds.includes(u.id));
    let changed = 0;
    for (const u of users) {
      const ext = this.claude.externalIdFor(u);
      if (!ext) continue;
      const cap = (await walletFor(this.db, this.cfg, u, period)).claudeCapCents;
      const prev = await this.db.get<{ period: string; cents: number }>("SELECT period, cents FROM claude_caps WHERE user_id = ?", u.id);
      if (prev && prev.period === period && Number(prev.cents) === cap) continue;
      await this.claude.setMonthlyCap(ext, cap);
      await this.db.run(
        "INSERT INTO claude_caps (user_id, period, cents, pushed_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(user_id) DO UPDATE SET period = excluded.period, cents = excluded.cents, pushed_at = excluded.pushed_at",
        u.id,
        period,
        cap,
        nowIso(),
      );
      await audit(this.db, "system", "claude.cap.set", { user: u.email, cents: cap, period });
      changed++;
    }
    return changed;
  }

  /**
   * After a change to someone's budget, team, status or spend: push their Claude caps and
   * send (or re-arm) budget alerts. Never throws; failures are logged.
   */
  async afterChange(userIds?: number[]): Promise<void> {
    await this.pushCaps(userIds).catch((e) => console.error("cap push failed:", e));
    await this.alerts.check(userIds).catch((e) => console.error("budget alerts failed:", e));
  }

  private readonly instanceId = randomUUID();

  /**
   * With several replicas on one Postgres database, only the holder of a short lease runs
   * the scheduled sync. The lease is a row in settings whose updated_at is its expiry; a
   * replica that dies loses it after three intervals. Manual "Sync now" ignores the lease.
   */
  async claimSyncLease(now = Date.now()): Promise<boolean> {
    const until = new Date(now + this.cfg.syncIntervalSeconds * 3000).toISOString();
    const res = await this.db.run(
      "INSERT INTO settings (key, value, updated_at) VALUES ('sync_lease', ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at " +
        "WHERE settings.value = excluded.value OR settings.updated_at < ?",
      this.instanceId,
      until,
      new Date(now).toISOString(),
    );
    return res.changes > 0;
  }

  start(): () => void {
    const tick = () => {
      this.claimSyncLease()
        .then(async (leader) => {
          if (!leader) return;
          await this.run();
          // PR counts are slow (rate-limited search); run them after, without holding up the next sync.
          this.output.refreshIfDue().catch((e) => console.error("output refresh failed", e));
        })
        .catch((e) => console.error("sync failed", e));
    };
    tick();
    const t = setInterval(tick, this.cfg.syncIntervalSeconds * 1000);
    t.unref();
    return () => clearInterval(t);
  }
}
