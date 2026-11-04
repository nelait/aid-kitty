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

## Return on spend

**Admin → Return on spend** puts AI spend (every tool) next to merged pull requests, per team and per month:

- **Org:** spend, merged PRs by people in Dev Hub (and the whole GitHub org's total), spend per merged PR, and PRs whose description says "Generated with Claude Code". That last count is a lower bound, because the marker can be turned off.
- **By team:** spend, PRs, spend per PR, and each team's share of spend against its share of PRs.
- **Last 6 months:** the same figures as a trend.
- **By person:** collapsed by default, with a warning not to use it as a leaderboard.
- **CSV:** `GET /api/admin/roi?period=YYYY-MM&format=csv`.

PRs are counted with GitHub's search API (`org:<org> is:pull-request is:merged author:<login> merged:<month>`) using the `GITHUB_ORG` and `GITHUB_TOKEN` connector credentials. Search allows about 30 calls a minute, so Dev Hub spaces its calls about 2 seconds apart (`githubSearchIntervalMs`). It refreshes the current month every 6 hours (`outputRefreshHours`) and last month once more after it ends. If it hits a rate limit, it keeps what it counted, marks the month incomplete and finishes on the next run. Admins can also recount from the page.

Only people with a GitHub login in Dev Hub have their PRs counted. Spend from people without one is shown but left out of every per-PR figure, so it can't inflate them, and the page asks admins to add the missing logins.

PR counts are a rough signal of output, not a productivity measure: PRs differ in size and difficulty, and spend isn't the only thing that changes output. The page says so, and leads with team and org views.

## One policy for every tool

Admins write one AI usage policy under **Admin → Policy**, and Dev Hub translates it for each tool:

| Rule | Claude Code | GitHub Copilot | Cursor |
| --- | --- | --- | --- |
| Allowed Claude models | `availableModels` + `enforceAvailableModels` | — | — |
| Protected files (gitignore patterns) | `Read(...)` and `Edit(...)` deny rules | Org content exclusions for every repository (`"*"`) | Suggested `.cursorignore` (not enforced) |
| Blocked shell commands | `Bash(...)` deny rules | — | — |
| Allowed / blocked MCP servers | `allowedMcpServers` / `deniedMcpServers` | — | — |
| Web fetch and search off | `WebFetch` and `WebSearch` deny rules | — | — |
| Block bypass-permissions mode | `disableBypassPermissionsMode: "disable"` | — | — |
| Extra managed settings (advanced JSON) | Merged in as-is | — | — |

**Teams can only tighten.** A team's rules add denies, narrow the allowed models or MCP servers, or turn web access off. Dev Hub refuses a team rule that would loosen the org policy, and refuses an org change that a team's rules would then loosen.

**How each tool gets it:**

- **Claude Code, live (recommended):** Dev Hub generates a small [`policyHelper`](https://code.claude.com/docs/en/settings-reference#policyhelper) script. Deploy it once with MDM, plus `/etc/devhub/policy.env` (Dev Hub URL and `DEVHUB_POLICY_TOKEN`) and a `policyHelper` entry in `managed-settings.json`. Claude Code then fetches the person's policy at startup and every 15 minutes from `GET /api/policy/claude-code`. The helper keeps the last policy it received, so an outage doesn't block anyone. On the very first run with no network it fails, so Claude Code doesn't start without a policy. The helper identifies the person by their git email. That can't be verified, so team rules apply on a best-effort basis; because teams only tighten, a wrong email still gets the full org policy.
- **Claude Code, static:** download a `managed-settings.json` for the org or a team and deploy it with MDM.
- **Claude apps gateway:** download the `managed.policies` block and paste it into `gateway.yaml`. Team entries match the IdP group with the team's exact name, which the gateway reads from the signed-in token. This is the way to enforce team rules strictly. `forceLoginMethod` and `forceLoginOrgUUID` are left out of this block, as the gateway requires.
- **GitHub Copilot:** the page previews the change and applies it when an admin clicks **Apply to GitHub**. Only the all-repositories (`"*"`) rule changes; per-repository rules set in GitHub are kept. GitHub's API drops comments in these rules, and this API is in public preview. The org owner's token needs the `copilot` scope.
- **Cursor:** Cursor has no admin policy API, so Dev Hub only suggests a `.cursorignore` to commit to repositories.

Every policy change is written to the audit log with its before and after.

## Budget alerts

After every sync (and whenever an admin changes a budget, team or spend), Dev Hub checks each active person's whole budget across all tools:

| When | Who hears about it |
| --- | --- |
| Spend passes `wallet.warnAt` (default 80%) | The person, by email: what they've spent per tool, what's left, when it resets, and where to ask for more |
| The budget is used up (personal limit or team pool) | The person, the managers of their team (with a link to approvals), and Slack if a webhook is set |

Each alert goes out once per person per month. If an approved increase brings someone back under a level, that level re-arms. Someone who jumps straight past 100% gets one email, not two. If sending fails, the next check retries. Set `notify.budgetAlerts: false` to turn alerts off.

Claude Code also shows its own warnings at 75% and 95% of the Claude cap. Dev Hub's alerts cover the whole budget across every tool.

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
npm test                       # 80 tests on SQLite: wallet math, connectors against mock Claude/GitHub/Cursor APIs, SCIM, licensing, API + portal flows
DEVHUB_TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm test   # the same suite on Postgres (creates and drops a database per test file)
npm run build && npm start
```

Configure it with environment variables or a `devhub.config.json` file (see `devhub.config.example.json`):

| Variable | Purpose |
| --- | --- |
| `DEVHUB_PUBLIC_URL`, `PORT`, `DEVHUB_DB` | Where it's served and the SQLite file |
| `DATABASE_URL` | `postgres://user:pass@host:5432/devhub` to use Postgres instead of SQLite (needed for more than one replica) |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Okta (or any OIDC IdP). Redirect URI: `<public url>/auth/callback` |
| `OIDC_ADMIN_GROUP`, `OIDC_GROUPS_CLAIM` | IdP group that makes people Dev Hub admins; claim name (default `groups`) |
| `CLAUDE_ADMIN_BASE_URL`, `CLAUDE_ADMIN_KEY`, `CLAUDE_MODE` | Gateway URL + an `admin.write_keys` key (`gateway`), or `https://api.anthropic.com` + a scoped key (`enterprise`) |
| `CLAUDE_ENFORCE_CAPS` | `false` to report without setting caps |
| `GITHUB_ORG`, `GITHUB_TOKEN` | Copilot seats and premium-request overage. The overage report requires an org admin's token; seats need `manage_billing:copilot` or `read:org` |
| `CURSOR_API_KEY` | Cursor team spend (Cursor Admin API key) |
| `DEVHUB_ADMIN_TOKEN` | Bearer token for automation (onboarding scripts, Terraform) |
| `DEVHUB_POLICY_TOKEN` | Read-only token developers' machines use to fetch the Claude Code policy (see [One policy for every tool](#one-policy-for-every-tool)) |
| `DEVHUB_SCIM_TOKEN` | Bearer token Okta uses for SCIM provisioning at `/scim/v2`. SCIM is off when unset |
| `DEVHUB_SLACK_WEBHOOK_URL` | Slack notifications for requests, decisions and used-up budgets |
| `SMTP_URL`, `DEVHUB_EMAIL_FROM` | Email for budget alerts, e.g. `smtps://user:pass@smtp.acme.io:465` and `Dev Hub <devhub@acme.io>`. Without `SMTP_URL`, emails are only logged |
| `DEVHUB_LICENSE` or `DEVHUB_LICENSE_FILE` | Signed license (contents or path). Admins can also install one with `PUT /api/admin/license` |
| `DEVHUB_DEV_LOGIN=true` | Email-only login for local development. **Never in production.** |

Day to day, admins work in the portal under **Admin**:

| Page | What it does |
| --- | --- |
| Overview | Spend by team and person, chargeback CSV, sync status, license summary |
| People | Search, add, edit (team, role, status, budget, GitHub login, Claude ID) and import a CSV. Admins can't demote or disable themselves |
| Teams | Add and edit teams, cost centers, per-person budgets and shared pools; members' caps update on save |
| Unmatched spend | Spend from accounts no one is linked to; link a Claude identity or GitHub login to a person and their spend moves into their budget |
| License | Status, seats and expiry; paste a license file to install it |

Everything there is also available through the API below.

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

## Deploy (self-hosted)

Dev Hub ships as a container image, a Helm chart and a Terraform module. Pick a database:

| | SQLite (default) | Postgres |
| --- | --- | --- |
| Setup | Nothing: a file on a persistent volume | `DATABASE_URL` pointing at a managed Postgres (RDS, Cloud SQL, Azure Database) or your own, version 13 or later (tested on 16) |
| Replicas | One. Upgrades use Recreate (a few seconds of downtime) | Several, with rolling upgrades and no downtime |
| Backups | Volume snapshots | Your Postgres backups |
| Good for | Evaluation and small teams | Production, high availability |

Dev Hub creates its schema on first start; replicas starting together take turns (a Postgres advisory lock). With several replicas, only one runs the scheduled sync at a time: it holds a lease in the database, and another replica takes over if it stops renewing for three sync intervals.

**Container image** (`Dockerfile`): multi-stage Node 22 build, runs as the non-root `node` user, data in `/data`, config at `/etc/devhub/devhub.config.json`.

```bash
docker build -t ghcr.io/your-org/devhub:0.1.0 .
```

**Helm** (`charts/devhub`): set `database.type=postgres`, `replicaCount` and `DATABASE_URL` in the Secret for Postgres; the chart then drops the volume and uses rolling updates, and refuses SQLite with more than one replica. Non-secret settings go under `config:` and are rendered into the config file. Secrets come from a Kubernetes Secret as environment variables. Point `secrets.existingSecret` at one you manage (External Secrets, Vault), or set `secrets.values` for a quick evaluation. The pod runs non-root with a read-only root filesystem, all capabilities dropped and no service-account token.

```bash
helm install devhub charts/devhub -n devhub --create-namespace \
  --set image.repository=ghcr.io/your-org/devhub \
  --set config.publicUrl=https://devhub.acme.io \
  --set config.auth.oidc.issuer=https://acme.okta.com/oauth2/default \
  --set config.auth.oidc.clientId=0oa... \
  --set secrets.existingSecret=devhub-secrets \
  --set ingress.enabled=true --set ingress.host=devhub.acme.io
```

**Terraform** (`terraform/modules/devhub`): installs the chart into an existing cluster and creates the Secret. Set `database_type = "postgres"`, `database_url` and `replicas` for high availability. See `terraform/examples/basic` for a complete example. Secrets passed in `var.secrets` end up in Terraform state, so protect the state or pass `existing_secret` instead. The module outputs the Okta redirect URI and SCIM base URL to paste into Okta.

## Supply chain: signed images and SBOMs

Every image CI publishes (from `main` and `devhub-v*` tags) is:

- **Signed** with [Sigstore cosign](https://docs.sigstore.dev/) using keyless signing: the signature is tied to this repository's `devhub.yml` workflow through GitHub's OIDC identity, so there's no signing key to leak or rotate. Signatures are recorded in Sigstore's public transparency log.
- **Shipped with an SBOM**: an SPDX SBOM (made with Syft) is attached to the image as a signed attestation, and BuildKit also attaches its own SBOM and SLSA build provenance. Every CI run, pull requests included, keeps the SPDX file as a downloadable artifact.

CI verifies both right after signing. Customers can check them before deploying:

```bash
IMAGE=ghcr.io/your-org/devhub@sha256:...   # the digest you plan to deploy
ID='https://github.com/your-org/your-repo/.github/workflows/devhub.yml@refs/tags/devhub-v0.1.0'

cosign verify "$IMAGE" --certificate-identity "$ID" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

cosign verify-attestation "$IMAGE" --type spdxjson --certificate-identity "$ID" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  | jq -r '.payload' | base64 -d | jq '.predicate.packages | length'
```

Then deploy that exact image by digest: `image.digest` in Helm or `image_digest` in Terraform (both reject anything that isn't `sha256:` plus 64 hex characters). For an admission controller that refuses unsigned images, point Sigstore policy-controller or Kyverno at the same identity and issuer.

## Licensing

Licenses are JSON files signed with the vendor's Ed25519 key and checked offline: Dev Hub never calls home.

| State | What happens |
| --- | --- |
| No license | Evaluation mode: up to 5 active people |
| Valid | Up to the licensed seats plus 10% (at least one) for true-up |
| Expired, within 30 days | Everything works; the admin page asks to renew |
| Expired, after 30 days | Existing people keep working, but no one new can be added or reactivated |
| Invalid signature | Treated as no license |

A license problem **never turns off budget enforcement**: spend sync and Claude caps keep running, so the customer's cost controls don't depend on the license. Seat limits apply when people are added by the admin API, SCIM or first sign-in. A bulk import that would go over the limit is rejected as a whole.

Vendor workflow:

```bash
npm run license -- keygen ./keys          # once: keep license-private.pem in a secret manager
#   then paste license-public.pem into VENDOR_PUBLIC_KEY_PEM in src/license.ts and release
npm run license -- issue --key ./keys/license-private.pem --customer "Acme" --seats 10 --days 365 --out acme.license.json
npm run license -- verify acme.license.json
```

This build has **no vendor public key yet**, so every install runs in evaluation mode until you generate your key pair and set `VENDOR_PUBLIC_KEY_PEM`.

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
| **Done (Phase 1d)** | Container image, Helm chart, Terraform module, signed license file with seat limits | Self-hosted packaging for the license model |
| **Done (Phase 1e)** | Postgres support, several replicas, sync leader lease | High availability |
| **Done (Phase 1k)** | Return on spend: spend vs merged PRs by team and month, 6-month trend, Claude Code-marked PRs, CSV | Shows what the AI budget buys |
| **Done (Phase 1j)** | One policy for every tool: Claude Code (live helper, static file, gateway block), Copilot content exclusions; team rules only tighten | Security teams set rules once |
| **Done (Phase 1i)** | Keyless-signed images, SPDX SBOM attestation, SLSA provenance, deploy by digest | Customers can verify what they run |
| **Done (Phase 1h)** | Budget alerts by email at 80% and 100%; managers told when someone runs out | People hear before they're blocked |
| **Done (Phase 1g)** | Admin pages in the portal: people (add, edit, search, CSV import), teams and budgets, unmatched spend linking, license install | Run Dev Hub without the API |
| **Done (Phase 1f)** | CI: tests on SQLite and Postgres, Helm and Terraform checks, image build; publishes to GHCR from `main` and `devhub-v*` tags | Every change checked; image ready to deploy |
| P1 | AWS/GCP Marketplace listings | Distribution |
| Phase 2 | Workspaces in the customer's AWS/GCP (Coder as a backend, or a built-in EC2/GCE template) | |
| Phase 3 | Per-PR preview environments with TTL | |

## Connector notes

- **Copilot overage.** GitHub breaks premium-request usage down per user only when filtered by `user`, so Dev Hub makes one call per seat. It caches the results and refreshes them every `premiumRefreshMinutes` (default 60), with at most four requests in flight. Only Copilot line items count, at `netAmount` (after the plan's included allowance). Set `premiumRequests: false` to count seats only.
- **Cursor.** Spend is read per member and matched by email. Cursor reports spend for the team's billing cycle, which may not start on the 1st; Dev Hub treats it as the current month's spend. **The request and response shape was written from memory and has not been checked against Cursor's docs or a live team** (Cursor's docs weren't reachable from the build environment). The connector checks the response strictly and fails the pull rather than record wrong numbers. Verify it against a real team before relying on it.

Known limits: amounts are the vendors' own estimates (a budget control, not an invoice). Copilot seats are priced from the config. Several people drawing on a team pool at the same moment can overshoot it by up to one sync interval of spend.
