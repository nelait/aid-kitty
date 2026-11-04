import type { Config } from "./config.js";
import { audit, nowIso, type Db, type User } from "./db.js";

/**
 * Output side of return-on-spend: merged pull requests per person per month, counted with
 * GitHub's search API (`org:<org> is:pull-request is:merged author:<login> merged:<range>`).
 *
 * Search allows about 30 requests a minute, so calls are spaced out (searchIntervalMs) and
 * a month is refreshed every outputRefreshHours, not on every spend sync. A rate-limit
 * response stops the run and marks the month incomplete; the next run fills it in.
 */

export interface OutputRefresh {
  period: string;
  people: number;
  complete: boolean;
  message: string;
}

export function periodRange(period: string): { start: string; end: string } {
  const [y, m] = period.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${period}-01`, end: `${period}-${String(last).padStart(2, "0")}` };
}

export const previousPeriod = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
};

class RateLimited extends Error {}

export class OutputService {
  private running: Promise<OutputRefresh[]> | null = null;

  constructor(
    private db: Db,
    private cfg: Config,
    private now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return !!this.cfg.connectors.copilot;
  }

  private async search(q: string): Promise<{ count: number; incomplete: boolean }> {
    const gh = this.cfg.connectors.copilot!;
    const url = new URL(`${gh.apiUrl}/search/issues`);
    url.searchParams.set("q", q);
    url.searchParams.set("per_page", "1");
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${gh.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 403 || res.status === 429) throw new RateLimited(`GitHub search rate limit (HTTP ${res.status})`);
    if (!res.ok) throw new Error(`GitHub search returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { total_count?: unknown; incomplete_results?: unknown };
    if (typeof body.total_count !== "number") throw new Error("GitHub search response has no total_count");
    return { count: body.total_count, incomplete: body.incomplete_results === true };
  }

  private async store(period: string, subject: string, metric: string, value: number) {
    await this.db.run(
      "INSERT INTO output_metrics (period, subject, metric, value, synced_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(period, subject, metric) DO UPDATE SET value = excluded.value, synced_at = excluded.synced_at",
      period,
      subject,
      metric,
      value,
      nowIso(),
    );
  }

  /** Count merged PRs for one month. Concurrent calls share one run. */
  refresh(period: string): Promise<OutputRefresh[]> {
    this.running ??= this.doRefresh([period]).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doRefresh(periods: string[]): Promise<OutputRefresh[]> {
    const out: OutputRefresh[] = [];
    for (const period of periods) out.push(await this.refreshOne(period));
    return out;
  }

  private async refreshOne(period: string): Promise<OutputRefresh> {
    if (!this.enabled) return { period, people: 0, complete: false, message: "GitHub isn't configured" };
    const org = this.cfg.connectors.copilot!.org;
    const { start, end } = periodRange(period);
    const base = `org:${org} is:pull-request is:merged merged:${start}..${end}`;
    // Everyone with a GitHub login who was active or spent anything that month.
    const people = await this.db.all<User>(
      `SELECT * FROM users WHERE github_login IS NOT NULL
         AND (status = 'active' OR id IN (SELECT user_id FROM spend WHERE period = ?))
       ORDER BY id`,
      period,
    );
    const gap = this.cfg.githubSearchIntervalMs ?? 2100;
    const pause = () => new Promise((r) => setTimeout(r, gap));
    let done = 0;
    let complete = true;
    let message = "";
    try {
      const total = await this.search(base);
      await this.store(period, "org", "merged_prs", total.count);
      await pause();
      // Claude Code puts "Generated with Claude Code" in PR descriptions unless that's turned off.
      const marked = await this.search(`${base} in:body "Generated with Claude Code"`);
      await this.store(period, "org", "claude_marked_prs", marked.count);
      complete &&= !total.incomplete && !marked.incomplete;
      for (const u of people) {
        await pause();
        const r = await this.search(`${base} author:${u.github_login}`);
        await this.store(period, `user:${u.id}`, "merged_prs", r.count);
        complete &&= !r.incomplete;
        done++;
      }
      message = `${done} people counted`;
    } catch (e) {
      complete = false;
      message = `${(e as Error).message}; counted ${done} of ${people.length} people, the rest next run`;
      if (!(e instanceof RateLimited)) console.error("output refresh failed:", e);
    }
    await this.db.run(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      `output:${period}`,
      JSON.stringify({ at: new Date(this.now()).toISOString(), complete, message }),
      nowIso(),
    );
    await audit(this.db, "system", "output.refreshed", { period, done, complete });
    return { period, people: done, complete, message };
  }

  async lastRefresh(period: string): Promise<{ at: string; complete: boolean; message: string } | null> {
    const row = await this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", `output:${period}`);
    return row ? JSON.parse(row.value) : null;
  }

  /**
   * Refresh this month when its counts are older than outputRefreshHours (or incomplete),
   * and last month once more after it ends so its final numbers are captured.
   */
  async refreshIfDue(): Promise<OutputRefresh[]> {
    if (!this.enabled || this.running) return [];
    const now = this.now();
    const current = new Date(now).toISOString().slice(0, 7);
    const prev = previousPeriod(current);
    const due: string[] = [];
    const prevLast = await this.lastRefresh(prev);
    if (!prevLast || !prevLast.complete || prevLast.at < `${current}-01`) due.push(prev);
    const curLast = await this.lastRefresh(current);
    const maxAge = (this.cfg.outputRefreshHours ?? 6) * 3_600_000;
    if (!curLast || !curLast.complete || now - Date.parse(curLast.at) >= maxAge) due.push(current);
    if (!due.length) return [];
    this.running = this.doRefresh(due).finally(() => {
      this.running = null;
    });
    return this.running;
  }
}
