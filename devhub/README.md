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

## Cloud workspaces

Developers create cloud development machines from **Workspaces** in the portal, using templates admins define under **Admin → Workspaces**. A template runs on one of three backends; configure any combination:

| Backend | Machines | Developers connect through | Dev Hub's credentials |
| --- | --- | --- | --- |
| **AWS EC2** | EC2 instance: no public IP, IMDSv2 required, encrypted gp3 disk | AWS Session Manager (SSH or VS Code Remote-SSH) | Default AWS chain: IRSA or EKS Pod Identity |
| **Google Compute Engine** | Shielded VM: no external IP, startup script, `block-project-ssh-keys` | IAP TCP forwarding (SSH or VS Code Remote-SSH) | Application Default Credentials: GKE Workload Identity |
| **Coder** | Whatever the Coder template provisions (any cloud, Kubernetes) | `coder config-ssh`, then SSH or VS Code | A Coder session token |

**What a workspace is**
- **AWS and GCP:** on first boot, Dev Hub's setup script creates a `dev` user with the developer's SSH key and installs git, Node.js 22 and Claude Code. It also installs Dev Hub's [policy helper](#one-policy-for-every-tool), so Claude Code follows the organization's policy. The script runs once; GCP's startup scripts run on every boot, so it marks itself done. Machines are tagged or labelled `managed-by=devhub` with the owner and workspace ID. The page shows the `~/.ssh/config` block to use.
- **Coder:** Coder's template provisions the machine, so developers don't need to give Dev Hub an SSH key. Dev Hub creates the workspace for the person's Coder account (matched by email), and drives start, stop and delete through Coder's API. To get the org's Claude Code policy there, add the policy helper to the Coder template (download it from **Admin → Policy**).

**Lifecycle and cost**
- Each template sets how long a workspace runs before Dev Hub **stops it automatically** (1–24 hours). A developer can add 2 hours at a time, up to 12 hours from now. A stopped workspace keeps its disk.
- Running hours (at the template's price, to 4 decimals) plus disk storage (per GB-month, prorated) are charged to the developer's **budget wallet** as a `workspaces` tool, so compute counts against the same limit as AI spend. For Coder templates, the price is your estimate of what one machine costs per hour.
- Nobody can create or start a workspace once their budget is used up.
- Every sync reconciles with each backend: actual states are recorded and billing intervals opened or closed. A workspace deleted outside Dev Hub is marked deleted. If a backend is removed from the config, its workspaces are left as they are, not marked deleted.
- Deleting asks for confirmation and destroys the machine and its disk. Each person can have up to 3 workspaces (`workspaces.maxPerUser`). A template's backend can't change after it's created.

**Setup: AWS EC2**
1. Set `workspaces.aws.region` in the config file (or `DEVHUB_WORKSPACES_AWS_REGION`).
2. Give Dev Hub's pod an AWS role through IRSA or EKS Pod Identity (Helm: `serviceAccount.annotations`). A starting point for its policy (review it with your AWS admin):
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": ["ec2:RunInstances"], "Resource": "*" },
       { "Effect": "Allow", "Action": ["ec2:CreateTags"], "Resource": "*", "Condition": { "StringEquals": { "ec2:CreateAction": "RunInstances" } } },
       { "Effect": "Allow", "Action": ["ec2:StartInstances", "ec2:StopInstances", "ec2:TerminateInstances"], "Resource": "*",
         "Condition": { "StringEquals": { "aws:ResourceTag/managed-by": "devhub" } } },
       { "Effect": "Allow", "Action": ["ec2:DescribeInstances"], "Resource": "*" },
       { "Effect": "Allow", "Action": ["iam:PassRole"], "Resource": "arn:aws:iam::<account>:role/devhub-workspace" }
     ]
   }
   ```
3. Create the workspace instance profile (`devhub-workspace`) with `AmazonSSMManagedInstanceCore`, a private subnet with outbound internet (NAT) for package installs, and a security group with no inbound rules.
4. Use an Ubuntu or Debian AMI with the SSM agent (Ubuntu's official AMIs have it).
5. Developers need the AWS CLI with its Session Manager plugin, and `ssm:StartSession` on the `AWS-StartSSHSession` document. Limit it to their own instances, e.g. with a condition on `ssm:resourceTag/devhub:owner`.

**Setup: Google Compute Engine**
1. Set `workspaces.gcp.project` in the config file (or `DEVHUB_WORKSPACES_GCP_PROJECT`).
2. Give Dev Hub's Kubernetes service account a Google service account through GKE Workload Identity, with `roles/compute.instanceAdmin.v1` on the project. If templates set a VM service account, also give it `roles/iam.serviceAccountUser` on that account.
3. Use a subnetwork with Cloud NAT for package installs. Add a firewall rule allowing TCP 22 from IAP's range `35.235.240.0/20` to instances tagged `devhub-workspace`.
4. Use an Ubuntu or Debian image family, e.g. `projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64`.
5. Developers need the gcloud CLI and `roles/iap.tunnelResourceAccessor` (IAP-secured Tunnel User).

**Setup: Coder**
1. Set `workspaces.coder.url` in the config file (or `DEVHUB_WORKSPACES_CODER_URL`) and `CODER_SESSION_TOKEN` to a token for a Coder user who can create workspaces on behalf of others (an owner or user admin).
2. Each person needs a Coder account with the same email as in Dev Hub (Coder can provision accounts from Okta too).
3. In a Dev Hub template, name the Coder template and its organization (`default` works for single-org Coder). Dev Hub controls auto-stop, so either leave the Coder template's own auto-stop off or set it no shorter than Dev Hub's.

Set `DEVHUB_POLICY_TOKEN` so AWS and GCP workspaces can fetch the Claude Code policy.

**Idle stop.** Each template has a "stop when idle" limit (default 30 minutes, 0 turns it off, otherwise 10 to 480). A workspace counts as in use while anyone is connected over SSH (which includes VS Code Remote-SSH) or while its 1-minute load average is at least 0.3 per CPU, so builds, test runs and agents left working keep it running. Starting a workspace or choosing "Keep running" also counts as use.

- **AWS and GCP:** the setup script installs a small agent (`/usr/local/bin/devhub-agent`, run every minute by a systemd timer) that reports to `POST /api/workspaces/heartbeat` with a token unique to that machine. Dev Hub stores only a hash of the token, and it stops working when the workspace is deleted. Workspaces need outbound HTTPS to Dev Hub's public URL (they already do for the policy helper).
- **Coder:** Dev Hub uses Coder's own `last_used_at`, which Coder updates as people connect; no agent needed.
- Logged-in users get a terminal message 5 and 1 minutes before an idle stop, and 15, 5 and 1 minutes before a scheduled stop.
- If a machine's agent has never reported (blocked network, custom image), Dev Hub doesn't idle-stop it; the scheduled stop still applies. The admin page shows "no reports yet" for those.

**Budget stop.** Workspaces are paid from the same budget as AI tools, so when someone's budget is used up (on any tool), their running workspaces stop too:

- Dev Hub checks after every sync and whenever spend, a budget, a team or a person changes. A workspace's own running time counts immediately, not just from the next sync.
- Each running workspace gets 15 minutes' notice (`workspaces.budgetGraceMinutes`, 0 to 240). The "used up" email says so, the agent shows a terminal message (when the stop is scheduled, then at 10, 5 and 1 minutes), and the Workspaces page shows when it will stop. "Keep running" is refused meanwhile.
- If the budget is raised before then (an approved increase, a bigger team pool, an admin change), the stop is cancelled.
- Stopped workspaces can't be started until there's budget again. Disks are kept, so nothing is lost; disk storage keeps counting at its (small) monthly rate.
- When someone is deactivated (in Okta or by an admin), their workspaces stop straight away.
- Turn it off with `workspaces.stopWhenBudgetUsedUp: false`; workspaces then only stop on their schedule or when idle.

**Template setup scripts.** An AWS or GCP template can carry its own first-boot script, for toolchains, repo checkouts, internal certificates and the like:

- It runs once as root, after Dev Hub's own setup (the `dev` user, Git, Node.js, Claude Code, the policy helper and agent). It gets `DEVHUB_USER_EMAIL`, `DEVHUB_WORKSPACE_NAME` and `DEVHUB_USER` (`dev`); use `sudo -u dev ...` for steps that should run as the developer.
- Without a `#!` line it runs with bash in strict mode (`set -euo pipefail`), so a failing step fails the script. Up to 32 KB; download anything bigger. On AWS, setup scripts over EC2's 16 KB user-data limit are gzipped automatically.
- Output goes to `/var/log/devhub-template-setup.log`. The agent reports whether it's running, done or failed (with the exit code), and the Workspaces pages show it. A failure doesn't stop the rest of setup or the machine.
- The script is stored in the machine's user data (EC2) or metadata (GCP), which people with read access to the instance can see: don't put secrets in it. Fetch them at run time instead, e.g. from AWS Secrets Manager or Google Secret Manager using the workspace's instance role or service account.
- Edits apply to new workspaces. Every version is kept in the audit log, with its SHA-256.
- Coder templates set machines up in Coder itself, so they don't take one.

## Preview environments

Every open pull request in a configured repository gets its own running copy of the app, at `https://pr-<number>-<repo>.<previews.domain>`, behind your company sign-in:

- **Admin → Previews → Add a repository:** the repo, a workspace template (AWS or GCP) for the machine, the port the app listens on, a build command (e.g. `npm ci && npm run build`) and a start command (e.g. `npm start`). Optionally: only PRs with a label, and how many hours without a push before a preview is removed (default 72).
- When a PR opens, Dev Hub creates a machine and comments on the PR. The machine downloads the PR's latest commit **through Dev Hub**, so no GitHub credentials ever go onto it. It runs the build as an unprivileged `preview` user, starts the app as a systemd service, and checks it answers. Each push redeploys in place; if a build fails, the last good build keeps serving and the PR comment says so.
- **Sign-in:** opening a preview goes through Dev Hub's Okta sign-in (a short-lived token is handed to the preview's host, which sets its own cookie). Dev Hub then proxies requests, including WebSockets, to the machine's private IP, and tells the app who's asking in `X-Forwarded-Email` (any value the browser sends is replaced). Previews never get a public IP.
- **Cost:** the machine time is charged to the PR author's budget, matched by their GitHub login in Dev Hub. PRs from people Dev Hub doesn't know, or from forks (which would run outside code inside your network), are skipped with a comment explaining why. Forks can be allowed per repo.
- **Cleanup:** a preview is removed when its PR closes or merges, after the hours-without-a-push limit, or when an admin removes it; a new push brings it back. If the author's budget runs out, it stops like a workspace and starts again once there's budget. At most 20 run at once (`previews.maxActive`).
- **Updates:** with a GitHub webhook, previews react within seconds; without one, on each sync (every 5 minutes by default). Dev Hub only acts on what GitHub's API says, so a failed GitHub call never removes a preview.

**Setup**
1. Choose a domain for previews, e.g. `preview.devhub.acme.io`. Point `*.preview.devhub.acme.io` at Dev Hub (in the Helm chart: `ingress.previewHost: "*.preview.devhub.acme.io"`) with a wildcard TLS certificate, and set `previews.domain` in the config (or `DEVHUB_PREVIEW_DOMAIN`).
2. `GITHUB_TOKEN` must be able to read the repositories' pull requests and contents, and write issue comments (a fine-grained token with Pull requests: read, Contents: read, Issues: write; or a classic token with `repo`).
3. Dev Hub must reach preview machines on the app's port: allow it from Dev Hub's pods in the template's security group (AWS) or a firewall rule for the `devhub-workspace` tag (GCP).
4. Optional, for immediate updates: set `DEVHUB_PREVIEW_WEBHOOK_SECRET`, and add a webhook in GitHub (repo or organization) to `https://<devhub>/api/previews/webhook`, content type `application/json`, with that secret and the "Pull requests" event.

The app must listen on `$PORT` on all interfaces (`$HOST` is `0.0.0.0`); `DEVHUB_PREVIEW_URL` has its public address. The template's setup script runs first, so install runtimes and databases there (Node.js 22 is already installed). Don't put secrets in build or start commands; fetch them from your secret manager with the machine's role. Changes to a repo's commands apply to previews created after the change.

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
npm test                       # 101 tests on SQLite: wallet math, connectors against mock Claude/GitHub/Cursor APIs, SCIM, licensing, API + portal flows
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
| `DEVHUB_WORKSPACES_AWS_REGION` | Turns on cloud workspaces in this AWS region (see [Cloud workspaces](#cloud-workspaces)) |
| `DEVHUB_WORKSPACES_GCP_PROJECT` | Turns on Google Compute Engine workspaces in this project |
| `DEVHUB_WORKSPACES_CODER_URL`, `CODER_SESSION_TOKEN` | Turns on Coder workspaces |
| `DEVHUB_AWS_MARKETPLACE_PRODUCT_SKU` | Bought through AWS Marketplace: check this product's License Manager license instead of a license file |
| `DEVHUB_GCP_MARKETPLACE=1`, `DEVHUB_UBBAGENT_URL` | Bought through Google Cloud Marketplace: report usage to the metering agent (default `http://127.0.0.1:6080`) |
| `DEVHUB_PREVIEW_DOMAIN`, `DEVHUB_PREVIEW_WEBHOOK_SECRET` | Turns on PR preview environments (wildcard domain), and verifies GitHub's webhook |
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


### Buying through AWS or Google Cloud Marketplace

Instead of a license file, Dev Hub can be bought through a cloud marketplace and billed on the buyer's cloud invoice:

- **AWS Marketplace** (contract pricing, per person): set `awsMarketplace.productSku` in the Helm chart (or `DEVHUB_AWS_MARKETPLACE_PRODUCT_SKU`). On every sync Dev Hub reads the buyer's AWS License Manager license for the product, only trusting licenses AWS Marketplace issued, and checks it out. The purchased Users become the seat count, with the usual 10% true-up allowance. Its service account needs `license-manager:ListReceivedLicenses` and `license-manager:CheckoutLicense` ([policy](marketplace/aws/iam-policy.json)).
- **Google Cloud Marketplace** (usage-based, per active person per hour): the chart's `gcpMarketplace.*` values add Google's metering agent as a sidecar. Every hour Dev Hub reports the number of active people. Each hour is reported exactly once, even with several replicas, and up to a day is caught up after an outage. There's no seat limit.
- If a check or report keeps failing (network, permissions, agent down), the last good state holds for 30 days. After that, or as soon as AWS says the subscription has ended, no new people can be added. As with license files, existing people and budget enforcement keep working.
- Admin → License shows where the subscription comes from and its state.

The packaging scripts and the seller-side checklist are in [`marketplace/`](marketplace/README.md).

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
| POST | `/api/previews/webhook` | GitHub (signed with `DEVHUB_PREVIEW_WEBHOOK_SECRET`) |
| GET | `/api/previews/target`, `/api/previews/source?sha=` | A preview machine (its own token) |
| POST | `/api/previews/status?sha=&status=` | A preview machine (its own token) |

Cookie-authenticated writes need the session's CSRF token in `x-devhub-csrf` or a `_csrf` form field. The automation bearer token is exempt.

## Security notes

- Sessions are random 256-bit tokens stored as SHA-256 hashes, sent in HttpOnly, SameSite=Lax cookies (Secure over HTTPS), and expire after 12 hours. Disabling a user deletes their sessions.
- OIDC uses the authorization-code flow with PKCE (S256), state and nonce, and verifies the ID token against the IdP's JWKS (issuer and audience).
- An email already linked to one SSO identity can't be taken over by another.
- All HTML output is escaped, responses carry a strict CSP, and CSV cells are protected against formula injection.
- Every admin change, cap write, request and decision is written to `audit`.
- Preview hosts get their own HttpOnly cookie, scoped to that host and signed with a key kept in the database, issued only through a 2-minute handoff from a signed-in Dev Hub session. It stops working when the person is deactivated. Proxied requests carry the person's identity in headers Dev Hub sets; the browser can't supply them.

## Roadmap

| Priority | Item | Why |
| --- | --- | --- |
| **Done (Phase 1a)** | Wallet, team pools, Claude + Copilot connectors, cap enforcement, raise requests and approvals, chargeback CSV, Okta SSO, portal | The governance wedge |
| **Done (Phase 1b)** | Copilot premium-request overage; Cursor connector | Heavy Copilot users and Cursor teams counted in the wallet |
| **Done (Phase 1c)** | SCIM 2.0 for Okta (users, groups → teams, instant deprovisioning) | No manual user import; offboarding cuts AI spend immediately |
| **Done (Phase 1d)** | Container image, Helm chart, Terraform module, signed license file with seat limits | Self-hosted packaging for the license model |
| **Done (Phase 1e)** | Postgres support, several replicas, sync leader lease | High availability |
| **Done (Phase 2a)** | Cloud workspaces on AWS EC2: templates, private machines via Session Manager, Claude Code with the org policy, auto-stop, compute in the budget wallet | Developers get governed machines in the customer's cloud |
| **Done (Phase 1k)** | Return on spend: spend vs merged PRs by team and month, 6-month trend, Claude Code-marked PRs, CSV | Shows what the AI budget buys |
| **Done (Phase 1j)** | One policy for every tool: Claude Code (live helper, static file, gateway block), Copilot content exclusions; team rules only tighten | Security teams set rules once |
| **Done (Phase 1i)** | Keyless-signed images, SPDX SBOM attestation, SLSA provenance, deploy by digest | Customers can verify what they run |
| **Done (Phase 1h)** | Budget alerts by email at 80% and 100%; managers told when someone runs out | People hear before they're blocked |
| **Done (Phase 1g)** | Admin pages in the portal: people (add, edit, search, CSV import), teams and budgets, unmatched spend linking, license install | Run Dev Hub without the API |
| **Done (Phase 1f)** | CI: tests on SQLite and Postgres, Helm and Terraform checks, image build; publishes to GHCR from `main` and `devhub-v*` tags | Every change checked; image ready to deploy |
| **Done (Phase 1l)** | AWS Marketplace (contract pricing via License Manager) and Google Cloud Marketplace (hourly usage via the metering agent) integrations, chart support and release scripts; listings themselves are made in the seller consoles | Buyers pay on their cloud bill and draw down committed spend |
| **Done (Phase 2b)** | Google Compute Engine and Coder workspace backends alongside AWS | Workspaces wherever the customer runs |
| **Done (Phase 2c)** | Idle detection: stop workspaces nobody is using (agent on AWS/GCP, Coder's own activity), with terminal warnings | Idle machines stop costing money in 30 minutes, not 8 hours |
| **Done (Phase 2d)** | Stop running workspaces when a budget runs out (with a grace period and warnings) or their owner is deactivated | Workspace spend can't run past the budget |
| **Done (Phase 2e)** | Setup scripts per workspace template (AWS and GCP), with progress and failures shown in the portal and every version audited | Teams get machines ready for their stack, not a bare image |
| **Done (Phase 3)** | Per-PR preview environments: a machine per PR, redeployed on push, behind company sign-in, removed on close or after a TTL, charged to the author's budget | Reviewers click a link instead of checking out a branch |

## Connector notes

- **Copilot overage.** GitHub breaks premium-request usage down per user only when filtered by `user`, so Dev Hub makes one call per seat. It caches the results and refreshes them every `premiumRefreshMinutes` (default 60), with at most four requests in flight. Only Copilot line items count, at `netAmount` (after the plan's included allowance). Set `premiumRequests: false` to count seats only.
- **Cursor.** Spend is read per member and matched by email. Cursor reports spend for the team's billing cycle, which may not start on the 1st; Dev Hub treats it as the current month's spend. **The request and response shape was written from memory and has not been checked against Cursor's docs or a live team** (Cursor's docs weren't reachable from the build environment). The connector checks the response strictly and fails the pull rather than record wrong numbers. Verify it against a real team before relying on it.

Known limits: amounts are the vendors' own estimates (a budget control, not an invoice). Copilot seats are priced from the config. Several people drawing on a team pool at the same moment can overshoot it by up to one sync interval of spend.
