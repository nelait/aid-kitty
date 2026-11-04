import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Config } from "./config.js";
import type { Queryable } from "./db.js";

/**
 * Offline-verifiable license: a JSON payload signed with the vendor's Ed25519 key.
 *
 *   { "license": { "id", "customer", "seats", "issuedAt", "expiresAt", "plan" }, "signature": "<base64>" }
 *
 * The signature covers the canonical JSON of `license` (keys sorted). Dev Hub never calls
 * home. A license problem never switches off budget enforcement: an expired or over-seat
 * install keeps syncing spend and enforcing caps for existing people, and only refuses to
 * add more people.
 */

/**
 * The vendor's license-signing public key (PEM). Generate the key pair once with
 * `npm run license -- keygen`, paste the public key here, and keep the private key in a
 * secret manager. With no key set, every install runs in evaluation mode.
 */
export const VENDOR_PUBLIC_KEY_PEM: string | null = null;

/** Active people allowed without a license. */
export const EVALUATION_SEATS = 5;
/** Days after expiry before new activations are refused. */
export const EXPIRY_GRACE_DAYS = 30;

let publicKeyPem: string | null = VENDOR_PUBLIC_KEY_PEM;
/** Test hook: lets tests sign licenses with a throwaway key pair. */
export function setLicensePublicKeyForTests(pem: string | null): void {
  publicKeyPem = pem;
}

export interface LicensePayload {
  id: string;
  customer: string;
  seats: number;
  issuedAt: string;
  expiresAt: string;
  plan?: string;
}

export interface LicenseFile {
  license: LicensePayload;
  signature: string;
}

export interface LicenseStatus {
  state: "valid" | "grace" | "expired" | "evaluation" | "invalid";
  customer?: string;
  licenseId?: string;
  plan?: string;
  expiresAt?: string;
  seats: number;
  /** Seats plus the overage allowance: 10% of seats, at least one. */
  seatLimit: number;
  activeUsers: number;
  /** Whether new people can be added or reactivated right now. */
  canActivate: boolean;
  message: string;
}

/** JSON with object keys sorted at every level, so signer and verifier hash the same bytes. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Vendor side: sign a license payload. Used by scripts/license.ts and tests; the private key never ships. */
export function issueLicense(privateKeyPem: string, payload: LicensePayload): LicenseFile {
  const signature = sign(null, Buffer.from(canonicalJson(payload)), createPrivateKey(privateKeyPem)).toString("base64");
  return { license: payload, signature };
}

export function parseAndVerify(text: string): { ok: true; license: LicensePayload } | { ok: false; error: string } {
  let file: LicenseFile;
  try {
    file = JSON.parse(text);
  } catch {
    return { ok: false, error: "license file is not valid JSON" };
  }
  const l = file?.license;
  if (!l || typeof file.signature !== "string") return { ok: false, error: "license file needs license and signature" };
  if (
    typeof l.id !== "string" ||
    typeof l.customer !== "string" ||
    !Number.isInteger(l.seats) ||
    l.seats < 1 ||
    Number.isNaN(Date.parse(l.issuedAt)) ||
    Number.isNaN(Date.parse(l.expiresAt))
  ) {
    return { ok: false, error: "license fields are missing or malformed" };
  }
  if (!publicKeyPem) return { ok: false, error: "this build has no license public key; running in evaluation mode" };
  let valid = false;
  try {
    valid = verify(null, Buffer.from(canonicalJson(l)), createPublicKey(publicKeyPem), Buffer.from(file.signature, "base64"));
  } catch {
    valid = false;
  }
  return valid ? { ok: true, license: l } : { ok: false, error: "license signature is not valid" };
}

/** The license text in force: one uploaded by an admin, else DEVHUB_LICENSE, else the file at DEVHUB_LICENSE_FILE. */
export async function licenseText(db: Queryable, cfg: Config): Promise<string | null> {
  const row = await db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'license'");
  if (row) return row.value;
  if (cfg.license?.text) return cfg.license.text;
  if (cfg.license?.file) {
    try {
      return readFileSync(cfg.license.file, "utf8");
    } catch {
      return null;
    }
  }
  return null;
}

export async function activeUserCount(db: Queryable): Promise<number> {
  return Number((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND deleted_at IS NULL"))!.n);
}

export async function licenseStatus(db: Queryable, cfg: Config, now = Date.now()): Promise<LicenseStatus> {
  const activeUsers = await activeUserCount(db);
  const text = await licenseText(db, cfg);
  const evaluation = (state: LicenseStatus["state"], message: string): LicenseStatus => ({
    state,
    seats: EVALUATION_SEATS,
    seatLimit: EVALUATION_SEATS,
    activeUsers,
    canActivate: activeUsers < EVALUATION_SEATS,
    message,
  });
  if (!text) return evaluation("evaluation", `No license installed. Evaluation mode allows ${EVALUATION_SEATS} active people.`);
  const parsed = parseAndVerify(text);
  if (!parsed.ok) return evaluation("invalid", `${parsed.error}. Evaluation limits apply (${EVALUATION_SEATS} active people).`);

  const l = parsed.license;
  const seatLimit = l.seats + Math.max(1, Math.floor(l.seats * 0.1));
  const expires = Date.parse(l.expiresAt);
  const graceEnds = expires + EXPIRY_GRACE_DAYS * 86_400_000;
  const state: LicenseStatus["state"] = now < expires ? "valid" : now < graceEnds ? "grace" : "expired";
  const underSeats = activeUsers < seatLimit;
  const days = (ms: number) => Math.ceil(ms / 86_400_000);
  const message =
    state === "valid"
      ? activeUsers > l.seats
        ? `${activeUsers} active people on a ${l.seats}-seat license. Up to ${seatLimit} are allowed while you true up.`
        : `Licensed to ${l.customer} for ${l.seats} seats until ${l.expiresAt.slice(0, 10)}.`
      : state === "grace"
        ? `License expired on ${l.expiresAt.slice(0, 10)}. Renew within ${days(graceEnds - now)} days to keep adding people.`
        : `License expired on ${l.expiresAt.slice(0, 10)}. Existing people and budget enforcement keep working; new people can't be added until you renew.`;
  return {
    state,
    customer: l.customer,
    licenseId: l.id,
    plan: l.plan,
    expiresAt: l.expiresAt,
    seats: l.seats,
    seatLimit,
    activeUsers,
    canActivate: state !== "expired" && underSeats,
    message,
  };
}

export class LicenseLimitError extends Error {}

/** Call before creating or reactivating `count` people. */
export async function assertCanActivate(db: Queryable, cfg: Config, count = 1): Promise<void> {
  const s = await licenseStatus(db, cfg);
  if (s.state === "expired") throw new LicenseLimitError(s.message);
  if (s.activeUsers + count > s.seatLimit) {
    throw new LicenseLimitError(
      `License seat limit reached: ${s.activeUsers} of ${s.seatLimit} active people. Deactivate someone or extend the license.`,
    );
  }
}
