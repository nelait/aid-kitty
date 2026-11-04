import type { User } from "../db.js";

export interface SpendRow {
  /** Identity in the vendor's system (OIDC sub, Claude user ID, GitHub login). */
  externalId: string;
  cents: number;
}

export interface Connector {
  /** Stable tool key stored in the spend table, e.g. "claude", "copilot". */
  tool: string;
  /** Period-to-date spend for the current calendar month. */
  fetchMonthlySpend(): Promise<SpendRow[]>;
  /** The user's identity in this vendor's system, if known. */
  externalIdFor(user: User): string | null;
}

export interface CapEnforcer {
  /** Set the user's monthly cap, in cents, in the vendor's system. */
  setMonthlyCap(externalId: string, cents: number): Promise<void>;
}

export class ConnectorError extends Error {
  constructor(
    public connector: string,
    message: string,
  ) {
    super(`${connector}: ${message}`);
  }
}

export async function fetchJson(
  connector: string,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new ConnectorError(connector, `request to ${new URL(url).host} failed: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new ConnectorError(connector, `HTTP ${res.status} from ${new URL(url).pathname}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}
