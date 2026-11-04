import express from "express";
import { authRoutes, identify } from "./auth.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { apiRoutes } from "./routes/api.js";
import { adminPortalRoutes } from "./routes/admin-portal.js";
import { policyPortalRoutes } from "./routes/policy-portal.js";
import { portalRoutes } from "./routes/portal.js";
import { scimRoutes } from "./routes/scim.js";
import type { SyncService } from "./sync.js";

export function createApp(db: Db, cfg: Config, sync: SyncService) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    next();
  });
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.use(identify(db, cfg));
  app.use(authRoutes(db, cfg));
  app.use("/scim/v2", scimRoutes(db, cfg, sync));
  app.use("/api", apiRoutes(db, cfg, sync));
  app.use(adminPortalRoutes(db, cfg, sync));
  app.use(policyPortalRoutes(db, cfg));
  app.use(portalRoutes(db, cfg, sync));
  return app;
}
