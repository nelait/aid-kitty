/**
 * Vendor-side license tooling. Never ship the private key with Dev Hub.
 *
 *   npm run license -- keygen <dir>
 *       Writes license-private.pem and license-public.pem to <dir>. Paste the public key
 *       into VENDOR_PUBLIC_KEY_PEM in src/license.ts; keep the private key in a secret manager.
 *
 *   npm run license -- issue --key <private.pem> --customer "Acme" --seats 10 --days 365 [--plan team] [--out acme.license.json]
 *       Prints (or writes) a signed license file to send to the customer.
 *
 *   npm run license -- verify <license.json>
 *       Checks a license against the public key compiled into this build.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { issueLicense, parseAndVerify, type LicensePayload } from "../src/license.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

if (cmd === "keygen") {
  const dir = rest[0] ?? die("usage: keygen <dir>");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(join(dir, "license-private.pem"), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
  writeFileSync(join(dir, "license-public.pem"), pub);
  console.log(`Wrote ${join(dir, "license-private.pem")} (keep secret) and ${join(dir, "license-public.pem")}.`);
  console.log("Paste this into VENDOR_PUBLIC_KEY_PEM in src/license.ts:\n");
  console.log(pub);
} else if (cmd === "issue") {
  const key = readFileSync(flag("key") ?? die("--key <private.pem> is required"), "utf8");
  const seats = Number(flag("seats") ?? die("--seats is required"));
  if (!Number.isInteger(seats) || seats < 1) die("--seats must be a positive integer");
  const days = Number(flag("days") ?? 365);
  const now = new Date();
  const payload: LicensePayload = {
    id: `lic_${randomUUID()}`,
    customer: flag("customer") ?? die("--customer is required"),
    seats,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + days * 86_400_000).toISOString(),
    plan: flag("plan") ?? "standard",
  };
  const out = JSON.stringify(issueLicense(key, payload), null, 2) + "\n";
  const file = flag("out");
  if (file) {
    writeFileSync(file, out);
    console.log(`Wrote ${file}: ${payload.customer}, ${seats} seats, expires ${payload.expiresAt.slice(0, 10)}.`);
  } else process.stdout.write(out);
} else if (cmd === "verify") {
  const r = parseAndVerify(readFileSync(rest[0] ?? die("usage: verify <license.json>"), "utf8"));
  if (!r.ok) die(r.error);
  console.log("valid:", JSON.stringify(r.license));
} else {
  die(`unknown command ${cmd}; use keygen, issue or verify`);
}
