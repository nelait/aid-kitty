import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { SyncService } from "./sync.js";

const cfg = loadConfig();
const db = openDb(cfg.databasePath);
const sync = new SyncService(db, cfg);

if (cfg.auth.devLogin) {
  console.warn("WARNING: DEVHUB_DEV_LOGIN is on. Anyone can sign in as any email. Never use this in production.");
}
if (!cfg.auth.oidc && !cfg.auth.devLogin) {
  console.warn("No sign-in method configured: set OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET.");
}
if (sync.connectors.length === 0) {
  console.warn("No connectors configured: set CLAUDE_ADMIN_BASE_URL + CLAUDE_ADMIN_KEY and/or GITHUB_ORG + GITHUB_TOKEN.");
}

createApp(db, cfg, sync).listen(cfg.port, () => {
  console.log(`Dev Hub listening on ${cfg.publicUrl} (port ${cfg.port})`);
  sync.start();
});
