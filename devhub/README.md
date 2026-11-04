# Dev Hub — Phase 1: one AI budget across tools

Dev Hub gives each developer one monthly AI budget that covers every AI coding tool they use. Managers approve increases, and finance gets a chargeback report by cost center. It runs as self-hosted software in the customer's environment.

## Build vs. integrate

Anthropic's [Claude apps gateway](https://code.claude.com/docs/en/claude-apps-gateway) already does these things for Claude:

- OIDC sign-in (Okta, Entra, Google)
- per-group model access
- managed-settings delivery
- OTLP telemetry
- routing to the Anthropic API, Bedrock, Google Cloud or Foundry
- per-user [spend caps](https://code.claude.com/docs/en/claude-apps-gateway-spend-limits) enforced on every request

Dev Hub doesn't rebuild any of that. It sits above the gateway and adds what the gateway leaves out:

| Gap in the gateway | What Dev Hub adds |
| --- | --- |
| Caps cover Claude only | **One wallet** covering Claude, GitHub Copilot (seats + premium-request overage), Cursor, and any other tool via import. Dev Hub sets the Claude cap to *Claude spend so far + what's left in the wallet*, so the total across all tools stays inside the budget. |
| Group caps are per-seat defaults, not shared pools | **Team pools**: an optional monthly pool per team that clamps every member once it runs out. |
| No increase-request queue ("`spend_limit_increase_requests` isn't part of the gateway's admin API") | **Raise requests** with manager approval and Slack notifications. An approval raises the Claude cap right away. |
| No cost-center reporting | **Chargeback CSV** per person, team and cost center, with one column per tool. |
| No user directory ("the gateway has no user directory") | A **directory** kept in sync with Okta over **SCIM 2.0**, linking each person to their Okta `sub`, GitHub login and team, with spend from unknown identities flagged. Deactivating someone in Okta drops their Claude cap to $0 right away. |

The same connector also works with the **Claude Enterprise Admin API** (`mode: "enterprise"`), which serves the same spend-limits API at `api.anthropic.com`.

## How it works

```
 Okta ──OIDC──▶ Dev Hub portal + API ──(every 5 min)──┬─▶ Claude gateway / Enterprise Admin API
                 │  wallet, approvals, chargeback     │     GET  /v1/organizations/spend_limits/effective
                 │  SQLite                            │     POST /v1/organizations/spend_limits  (per-user cap)
                 │                                    ├─▶ GitHub  GET /orgs/{org}/copilot/billing/seats
                 │                                    │           GET /organizations/{org}/settings/billing/premium_request/usage?user=
                 │                                    └─▶ Cursor  POST /teams/spend
 Developer ─ claude /login → Cloud gateway ─────────────▶ Claude apps gateway ─▶ Anthropic / Bedrock / Vertex
```

1. **Pull:** each connector reports the current month's spend per identity. Dev Hub maps identities to people and replaces that tool's spend rows. Identities it can't map go to `unmatched_spend`.
2. **Compute:** wallet limit = base budget (user override → team default → org default) + approved increases this month. What's left = the lower of the personal remainder and the team pool's remainder.
3. **Enforce:** Dev Hub sets each person's Claude monthly cap to `claude_spend + remaining`, and writes only caps that changed. If any pull failed, it skips enforcement for that run so it never acts on understated spend. Disabled users get a cap of 0.

Enforcement lags spend by at most one sync interval for non-Claude tools. Claude spend itself is enforced live by the gateway.

## Run it

Requires Node 22.13 or later.

```bash
npm install
npm test                       # 37 tests: wallet math, connectors against mock Claude/GitHub/Cursor APIs, SCIM, API + portal flows
npm run build && npm start
```

Configure it with environment variables or a `devhub.config.json` file (see `devhub.config.example.json`):

| Variable | Purpose |
| --- | --- |
| `DEVHUB_PUBLIC_URL`, `PORT`, `DEVHUB_DB` | Where it's served and the SQLite file |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Okta (or any OIDC IdP). Redirect URI: `<public url>/auth/callback` |
| `OIDC_ADMIN_GROUP`, `OIDC_GROUPS_CLAIM` | IdP group that makes people Dev Hub admins; claim name (default `groups`) |
| `CLAUDE_ADMIN_BASE_URL`, `CLAUDE_ADMIN_KEY`, `CLAUDE_MODE` | Gateway URL + an `admin.write_keys` key (`gateway`), or `https://api.anthropic.com` + a scoped key (`enterprise`) |
| `CLAUDE_ENFORCE_CAPS` | `false` to report without setting caps |
| `GITHUB_ORG`, `GITHUB_TOKEN` | Copilot seats and premium-request overage. The overage report requires an org admin's token; seats need `manage_billing:copilot` or `read:org` |
| `CURSOR_API_KEY` | Cursor team spend (Cursor Admin API key) |
| `DEVHUB_ADMIN_TOKEN` | Bearer token for automation (onboarding scripts, Terraform) |
| `DEVHUB_SCIM_TOKEN` | Bearer token Okta uses for SCIM provisioning at `/scim/v2`. SCIM is off when unset |
| `DEVHUB_SLACK_WEBHOOK_URL` | Notifications for requests and decisions |
| `DEVHUB_DEV_LOGIN=true` | Email-only login for local development. **Never in production.** |

Set `claudeGatewayUrl` in the config file to show developers the gateway address on their wallet page.

### Onboard a 10-person company

```bash
H='-H "authorization: Bearer $DEVHUB_ADMIN_TOKEN" -H "content-type: application/json"'
curl -X POST $URL/api/admin/teams $H -d '{"name":"platform","cost_center":"CC-100","member_default_usd":300,"monthly_pool_usd":2500}'
curl -X POST $URL/api/admin/users $H -d '[
  {"email":"priya@acme.io","team":"platform","role":"manager","github_login":"priya-gh"},
  {"email":"sam@acme.io","team":"platform","github_login":"samdev"}
]'
```

Or let Okta do it: see [SCIM provisioning](#scim-provisioning-okta). People are linked to their Okta identity the first time they sign in. Anyone not added ahead of time is created on first sign-in (JIT) and placed in a team whose name matches one of their IdP groups.

## SCIM provisioning (Okta)

1. Generate a long random token and set it as `DEVHUB_SCIM_TOKEN`.
2. In Okta, open the Dev Hub app integration → **General** → enable **SCIM provisioning**. On the **Provisioning** tab set:
   - SCIM connector base URL: `<public url>/scim/v2`
   - Unique identifier field for users: `userName` (Dev Hub uses the email)
   - Supported actions: Push New Users, Push Profile Updates, Push Groups
   - Authentication mode: HTTP Header, with the token from step 1
3. Under **To App**, enable Create Users, Update User Attributes and Deactivate Users. Assign people or groups, and use **Push Groups** for the groups that should become teams.

These Okta labels are from Okta's standard SCIM app setup and may differ slightly in your admin console. Okta's **Test Connector Configuration** button checks the base URL and token.

What each Okta action does in Dev Hub:

| Okta action | Dev Hub |
| --- | --- |
| Assign a person | Creates the user, or links one an admin already added (same email). Their GitHub login, budget and history are kept |
| Update profile | Updates email and name; refuses an email another person already has |
| Deactivate / unassign | Disables the user, ends their sessions and pushes a $0 Claude cap immediately |
| Reactivate | Re-enables the user and restores their cap |
| Delete | Disables the user and hides them from SCIM. Their spend stays in chargeback reports; re-assigning them later restores the same record |
| Push a group | Creates a team, or links an existing team of the same name (its cost center and budgets are kept) |
| Group membership changes | Sets each member's team and re-checks Claude caps for everyone affected (team defaults and pools apply at once) |
| Delete a pushed group | Removes the team; its members stay, without a team |

Supported: `GET/POST/PUT/PATCH/DELETE` on `/Users` and `/Groups`, `eq` filters on `userName`, `externalId`, `emails.value` and `displayName`, `startIndex`/`count` paging, `excludedAttributes=members`, and both Okta-style and Entra-style PATCH bodies. Not supported: bulk operations, sorting, ETags, and other filter operators (they return `400 invalidFilter`).

A person belongs to one team, so adding them to a second pushed group moves them. Admin rights still come from the `OIDC_ADMIN_GROUP` claim at sign-in, not from SCIM.

## API

| Method | Path | Who |
| --- | --- | --- |
| GET | `/api/me` | Signed-in user: profile, wallet, CSRF token |
| GET/POST | `/api/me/raise-requests` | Signed-in user |
| GET | `/api/raise-requests?status=` | Managers (their team), admins |
| POST | `/api/raise-requests/:id/approve` · `/deny` | Managers (their team, never their own), admins |
| GET/POST/PATCH | `/api/admin/teams` | Admins |
| GET/POST | `/api/admin/users` (POST takes one user or an array; upsert by email) | Admins |
| POST | `/api/admin/sync` · GET `/api/admin/sync-runs` | Admins |
| POST | `/api/admin/spend-import` `{tool, period?, rows:[{email, usd}]}` | Admins, for tools without a connector |
| GET | `/api/admin/report?period=YYYY-MM&format=csv` | Admins |
| GET | `/api/admin/unmatched`, `/api/admin/audit` | Admins |

Cookie-authenticated writes need the session's CSRF token in `x-devhub-csrf` or a `_csrf` form field. The automation bearer token is exempt.

## Security notes

- Sessions are random 256-bit tokens stored as SHA-256 hashes, sent in HttpOnly, SameSite=Lax cookies (Secure over HTTPS), and expire after 12 hours. Disabling a user deletes their sessions.
- OIDC uses the authorization-code flow with PKCE (S256), state and nonce, and verifies the ID token against the IdP's JWKS (issuer and audience).
- An email already linked to one SSO identity can't be taken over by another.
- All HTML output is escaped, responses carry a strict CSP, and CSV cells are protected against formula injection.
- Every admin change, cap write, request and decision is written to `audit`.

## Roadmap

| Priority | Item | Why |
| --- | --- | --- |
| **Done (Phase 1a)** | Wallet, team pools, Claude + Copilot connectors, cap enforcement, raise requests and approvals, chargeback CSV, Okta SSO, portal | The governance wedge |
| **Done (Phase 1b)** | Copilot premium-request overage; Cursor connector | Heavy Copilot users and Cursor teams counted in the wallet |
| **Done (Phase 1c)** | SCIM 2.0 for Okta (users, groups → teams, instant deprovisioning) | No manual user import; offboarding cuts AI spend immediately |
| P1 | Postgres option; Helm chart + Terraform module; signed license file | Self-hosted packaging for the license model |
| P2 | Policy pack: generate the gateway's per-group `managed` blocks (MCP allowlist, permission denies) from one Dev Hub policy | One policy across tools |
| P2 | Spend → output reporting (join spend with GitHub PRs and commits) | ROI view for finance |
| Phase 2 | Workspaces in the customer's AWS/GCP (Coder as a backend, or a built-in EC2/GCE template) | |
| Phase 3 | Per-PR preview environments with TTL | |

## Connector notes

- **Copilot overage.** GitHub breaks premium-request usage down per user only when filtered by `user`, so Dev Hub makes one call per seat. It caches the results and refreshes them every `premiumRefreshMinutes` (default 60), with at most four requests in flight. Only Copilot line items count, at `netAmount` (after the plan's included allowance). Set `premiumRequests: false` to count seats only.
- **Cursor.** Spend is read per member and matched by email. Cursor reports spend for the team's billing cycle, which may not start on the 1st; Dev Hub treats it as the current month's spend. **The request and response shape was written from memory and has not been checked against Cursor's docs or a live team** (Cursor's docs weren't reachable from the build environment). The connector checks the response strictly and fails the pull rather than record wrong numbers. Verify it against a real team before relying on it.

Known limits: amounts are the vendors' own estimates (a budget control, not an invoice). Copilot seats are priced from the config. Several people drawing on a team pool at the same moment can overshoot it by up to one sync interval of spend.
