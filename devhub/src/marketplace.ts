import { randomUUID } from "node:crypto";
import { CheckoutLicenseCommand, LicenseManagerClient, ListReceivedLicensesCommand, type GrantedLicense } from "@aws-sdk/client-license-manager";
import type { Config } from "./config.js";
import { audit, type Db, type Queryable } from "./db.js";

/**
 * Buying Dev Hub through a cloud marketplace instead of with a license file.
 *
 * AWS Marketplace (container product, contract pricing): the buyer purchases a number of
 * people (one "Users" dimension). AWS License Manager holds the license in the buyer's
 * account; Dev Hub reads it (seat count, end date) and checks it out every sync.
 *
 * Google Cloud Marketplace (Kubernetes app, usage-based pricing): there's no seat limit.
 * Each hour Dev Hub reports how many people are active to the ubbagent sidecar, which
 * forwards it to Google for billing.
 *
 * Either way the result is stored, and licenseStatus() turns it into the same seat and
 * activation rules as a license file. A failed check never stops budget enforcement.
 */

/** Licenses issued by AWS Marketplace carry this key fingerprint (it's the same for every seller). */
export const AWS_MARKETPLACE_FINGERPRINT = "aws:294406891311:AWS/Marketplace:issuer-fingerprint";
/** Days a failing check keeps the last good entitlement (network or permission problems). */
export const MARKETPLACE_GRACE_DAYS = 30;
const HOUR = 3_600_000;

export interface MarketplaceConfig {
  aws?: {
    /** The product SKU from the AWS Marketplace Management Portal. */
    productSku: string;
    /** The dimension's API name for people (default "Users"). */
    entitlement?: string;
    /** License Manager's region (default: AWS_REGION, else us-east-1). */
    region?: string;
  };
  gcp?: {
    /** The metric's name in the Producer Portal pricing (default "active_users"), reported per hour. */
    metric?: string;
    /** The ubbagent sidecar's local API (default http://127.0.0.1:6080). */
    agentUrl?: string;
  };
}

/** What the last marketplace check found. Stored in settings as JSON. */
export interface MarketplaceState {
  source: "aws" | "gcp";
  checkedAt: string;
  /** Whether the last check succeeded and the buyer is entitled. */
  ok: boolean;
  /** "none": the marketplace says there's no entitlement (cancelled, expired). "error": the check itself failed. */
  failure?: "none" | "error";
  error?: string;
  /** The last successful check. */
  okAt?: string;
  /** AWS: people purchased; GCP: no limit (null). */
  seats: number | null;
  expiresAt?: string | null;
  customer?: string | null;
  /** GCP: the end of the last hour reported. */
  reportedThrough?: string | null;
}

export async function marketplaceState(db: Queryable): Promise<MarketplaceState | null> {
  const row = await db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'marketplace'");
  return row ? (JSON.parse(row.value) as MarketplaceState) : null;
}

async function saveState(db: Queryable, s: MarketplaceState) {
  // Never move the GCP reporting cursor backwards (another replica may have reported meanwhile).
  for (let i = 0; i < 5; i++) {
    const row = await db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'marketplace'");
    if (!row) break;
    const cur = JSON.parse(row.value) as MarketplaceState;
    const through = [cur.reportedThrough, s.reportedThrough].filter(Boolean).sort().pop() ?? null;
    const next = JSON.stringify({ ...s, reportedThrough: through });
    if ((await db.run("UPDATE settings SET value = ?, updated_at = ? WHERE key = 'marketplace' AND value = ?", next, s.checkedAt, row.value)).changes > 0) return;
  }
  await db.run(
    "INSERT INTO settings (key, value, updated_at) VALUES ('marketplace', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    JSON.stringify(s),
    s.checkedAt,
  );
}

/** The AWS calls Dev Hub makes; tests pass a fake. */
export interface LicenseManagerApi {
  listReceived(productSku: string): Promise<GrantedLicense[]>;
  checkout(productSku: string, entitlement: string, count: number): Promise<{ allowed: number; expiration?: string }>;
}

export function awsLicenseManager(region: string): LicenseManagerApi {
  const client = new LicenseManagerClient({ region });
  return {
    async listReceived(productSku) {
      const out: GrantedLicense[] = [];
      let next: string | undefined;
      do {
        const r = await client.send(new ListReceivedLicensesCommand({ Filters: [{ Name: "ProductSKU", Values: [productSku] }], NextToken: next }));
        out.push(...(r.Licenses ?? []));
        next = r.NextToken;
      } while (next);
      return out;
    },
    async checkout(productSku, entitlement, count) {
      const r = await client.send(
        new CheckoutLicenseCommand({
          ProductSKU: productSku,
          CheckoutType: "PROVISIONAL",
          KeyFingerprint: AWS_MARKETPLACE_FINGERPRINT,
          Entitlements: [{ Name: entitlement, Unit: "Count", Value: String(count) }],
          ClientToken: randomUUID(),
        }),
      );
      const got = r.EntitlementsAllowed?.find((e) => e.Name === entitlement);
      return { allowed: Number(got?.Value ?? 0), expiration: r.Expiration };
    },
  };
}

/** Errors that mean "not entitled", as opposed to "couldn't check". */
const NOT_ENTITLED = new Set(["NoEntitlementsAllowedException", "EntitlementNotAllowedException", "ResourceNotFoundException"]);

export class MarketplaceService {
  constructor(
    private db: Db,
    private cfg: Config,
    private opts: { licenseManager?: LicenseManagerApi; now?: () => number } = {},
  ) {}

  get source(): "aws" | "gcp" | null {
    return this.cfg.marketplace?.aws ? "aws" : this.cfg.marketplace?.gcp ? "gcp" : null;
  }

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  /** Check the entitlement (AWS) or report usage (GCP). Called on every sync; never throws. */
  async tick(): Promise<MarketplaceState | null> {
    if (this.source === "aws") return this.checkAws();
    if (this.source === "gcp") return this.reportGcp();
    return null;
  }

  private async activeUsers(): Promise<number> {
    const r = await this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND deleted_at IS NULL");
    return Number(r?.n ?? 0);
  }

  private async checkAws(): Promise<MarketplaceState> {
    const c = this.cfg.marketplace!.aws!;
    const dim = c.entitlement ?? "Users";
    const lm = (this.opts.licenseManager ??= awsLicenseManager(c.region ?? process.env.AWS_REGION ?? "us-east-1"));
    const prev = await marketplaceState(this.db);
    const at = new Date(this.now()).toISOString();
    const base = { source: "aws" as const, checkedAt: at, okAt: prev?.okAt, seats: prev?.seats ?? null, expiresAt: prev?.expiresAt ?? null, customer: prev?.customer ?? null };
    let s: MarketplaceState;
    try {
      // Only licenses AWS Marketplace issued count, and only ones in force.
      const licenses = (await lm.listReceived(c.productSku)).filter(
        (l) => l.Issuer?.KeyFingerprint === AWS_MARKETPLACE_FINGERPRINT && l.Status === "AVAILABLE",
      );
      const seatsOf = (l: GrantedLicense) => {
        const e = l.Entitlements?.find((x) => x.Name === dim);
        return Number(e?.MaxCount ?? e?.Value ?? 0);
      };
      const best = licenses.sort((a, b) => seatsOf(b) - seatsOf(a))[0];
      const seats = best ? seatsOf(best) : 0;
      if (!best || seats < 1) {
        s = { ...base, ok: false, failure: "none", error: `No active AWS Marketplace license for product ${c.productSku} with a "${dim}" entitlement in this account.` };
      } else {
        // AWS Marketplace requires a checkout. Ask for what's in use (within what's bought), at least one.
        const want = Math.min(seats, Math.max(1, await this.activeUsers()));
        await lm.checkout(c.productSku, dim, want);
        s = {
          source: "aws",
          checkedAt: at,
          ok: true,
          okAt: at,
          seats,
          expiresAt: best.Validity?.End ?? null,
          customer: best.Beneficiary ? `AWS account ${best.Beneficiary.split(":").pop()}` : "AWS Marketplace",
        };
      }
    } catch (e) {
      const name = (e as Error).name;
      s = NOT_ENTITLED.has(name)
        ? { ...base, ok: false, failure: "none", error: `AWS Marketplace says this account isn't entitled (${name}).` }
        : { ...base, ok: false, failure: "error", error: `Couldn't check the AWS Marketplace license: ${name}: ${(e as Error).message}` };
    }
    await this.record(prev, s);
    return s;
  }

  /**
   * Report each whole hour since the last report (up to a day back) as `metric` = people
   * active now. Each hour is claimed in the database (compare-and-swap) before it's sent, so
   * two replicas never bill the same hour, and released again if sending fails.
   */
  private async reportGcp(): Promise<MarketplaceState> {
    const c = this.cfg.marketplace!.gcp!;
    const agent = (c.agentUrl ?? "http://127.0.0.1:6080").replace(/\/$/, "");
    const metric = c.metric ?? "active_users";
    const now = this.now();
    const at = new Date(now).toISOString();
    const thisHour = Math.floor(now / HOUR) * HOUR;
    const prev = await marketplaceState(this.db);
    if (!prev) {
      await this.db.run(
        "INSERT INTO settings (key, value, updated_at) VALUES ('marketplace', ?, ?) ON CONFLICT (key) DO NOTHING",
        JSON.stringify({ source: "gcp", checkedAt: at, ok: false, seats: null, reportedThrough: null } satisfies MarketplaceState),
        at,
      );
    }
    let failure: string | null = null;
    try {
      const users = await this.activeUsers();
      // Bounded: at most 24 hours to report, plus retries when another writer changed the row.
      for (let attempt = 0; attempt < 100; attempt++) {
        const raw = (await this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'marketplace'"))!.value;
        const cur = JSON.parse(raw) as MarketplaceState;
        // The first report covers the hour just finished; afterwards, each hour since the last one.
        let start = cur.reportedThrough ? Date.parse(cur.reportedThrough) : thisHour - HOUR;
        start = Math.max(start, thisHour - 24 * HOUR);
        if (start + HOUR > thisHour) break;
        const claimed = JSON.stringify({ ...cur, reportedThrough: new Date(start + HOUR).toISOString() });
        const got = await this.db.run("UPDATE settings SET value = ?, updated_at = ? WHERE key = 'marketplace' AND value = ?", claimed, at, raw);
        // Someone else changed the row (another replica's report, or a status save): look again.
        // The cursor decides what's left, so an hour already claimed is never reported twice.
        if (got.changes === 0) continue;
        try {
          const res = await fetch(`${agent}/report`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: metric,
              startTime: new Date(start).toISOString(),
              endTime: new Date(start + HOUR).toISOString(),
              value: { int64Value: users },
            }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) throw new Error(`the metering agent refused the report: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        } catch (e) {
          await this.db.run("UPDATE settings SET value = ? WHERE key = 'marketplace' AND value = ?", raw, claimed);
          throw e;
        }
      }
      // The agent buffers and retries; its status says whether Google is accepting reports.
      const st = (await (await fetch(`${agent}/status`, { signal: AbortSignal.timeout(10_000) })).json()) as {
        lastReportSuccess?: string;
        currentFailureCount?: number;
      };
      if ((st.currentFailureCount ?? 0) > 0) {
        failure = `The metering agent can't reach Google (${st.currentFailureCount} failed reports in a row; last success ${st.lastReportSuccess ?? "never"}).`;
      }
    } catch (e) {
      failure = `Couldn't report usage to the metering agent: ${(e as Error).message}`;
    }
    const latest = (await marketplaceState(this.db))!;
    const s: MarketplaceState = failure
      ? { ...latest, source: "gcp", checkedAt: at, ok: false, failure: "error", error: failure, seats: null }
      : { ...latest, source: "gcp", checkedAt: at, ok: true, okAt: at, failure: undefined, error: undefined, seats: null, customer: "Google Cloud Marketplace" };
    await this.record(prev, s);
    return s;
  }

  private async record(prev: MarketplaceState | null, s: MarketplaceState) {
    await saveState(this.db, s);
    // Audit changes of state, not every hourly check.
    if (!prev || prev.ok !== s.ok || prev.seats !== s.seats || prev.failure !== s.failure) {
      await audit(this.db, "system", s.ok ? "marketplace.ok" : "marketplace.problem", { source: s.source, seats: s.seats, error: s.error ?? null });
    }
  }
}
