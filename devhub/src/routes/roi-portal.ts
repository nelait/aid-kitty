import express from "express";
import type { Db } from "../db.js";
import { previousPeriod } from "../output.js";
import { roiReport, type RoiRow } from "../roi.js";
import type { SyncService } from "../sync.js";
import { currentPeriod, fmtUsd } from "../wallet.js";
import { act, adminGuard, adminTabs, csrfField, esc, flash, page, wrap } from "./html.js";

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const perPr = (r: RoiRow) => (r.centsPerPr === null ? `<span class="muted">—</span>` : fmtUsd(r.centsPerPr));
const pct = (x: number) => `${Math.round(x * 100)}%`;
const monthName = (period: string) =>
  new Date(`${period}-01T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

export function roiPortalRoutes(db: Db, sync: SyncService) {
  const r = express.Router();
  r.use("/admin/roi", express.urlencoded({ extended: false, limit: "16kb" }));

  r.get(
    "/admin/roi",
    wrap(async (req, res) => {
      const p = adminGuard(req, res);
      if (!p) return;
      const now = currentPeriod();
      const period = PERIOD_RE.test(String(req.query.period ?? "")) ? String(req.query.period) : now;
      const rep = await roiReport(db, period);
      const refreshed = await sync.output.lastRefresh(period);

      const months: string[] = [];
      for (let m = now, i = 0; i < 6; i++, m = previousPeriod(m)) months.push(m);
      const picker = months
        .map((m) => (m === period ? `<b>${esc(monthName(m))}</b>` : `<a href="/admin/roi?period=${m}">${esc(monthName(m))}</a>`))
        .join(" · ");

      const freshness = !sync.output.enabled
        ? `<p><b>Connect GitHub</b> (GITHUB_ORG and GITHUB_TOKEN) to count merged pull requests. Spend is shown without output until then.</p>`
        : refreshed
          ? `<p class="muted">PR counts from ${esc(refreshed.at.slice(0, 16).replace("T", " "))} UTC${refreshed.complete ? "" : ` (incomplete: ${esc(refreshed.message)})`}.</p>`
          : `<p class="muted">PR counts for this month haven't been collected yet.</p>`;

      const tiles: [string, string, string][] = [
        ["AI spend", fmtUsd(rep.org.spendCents), `${rep.org.spendingPeople} people`],
        ["Merged PRs", String(rep.org.mergedPrs), rep.org.orgMergedPrs !== null ? `of ${rep.org.orgMergedPrs} in the GitHub org` : "by people in Dev Hub"],
        ["Spend per merged PR", rep.org.centsPerPr === null ? "—" : fmtUsd(rep.org.centsPerPr), rep.org.unlinkedSpenders ? "people with a GitHub login only" : "across all AI tools"],
        ["PRs marked “Generated with Claude Code”", rep.org.claudeMarkedPrs === null ? "—" : String(rep.org.claudeMarkedPrs), "a lower bound: the marker can be turned off"],
      ];

      const teamRows = rep.teams
        .map(
          (t) => `<tr><td>${esc(t.team)}${t.costCenter ? `<div class="muted">${esc(t.costCenter)}</div>` : ""}</td>
            <td class="n">${t.people}</td><td class="n">${fmtUsd(t.spendCents)}</td><td class="n">${t.mergedPrs}</td>
            <td class="n">${perPr(t)}</td><td class="n">${pct(t.spendShare)} / ${pct(t.prShare)}</td></tr>`,
        )
        .join("");

      const trendRows = rep.trend
        .map(
          (t) => `<tr><td>${esc(monthName(t.period))}</td><td class="n">${fmtUsd(t.spendCents)}</td><td class="n">${t.mergedPrs}</td>
            <td class="n">${perPr(t)}</td><td class="n">${t.orgMergedPrs ?? `<span class="muted">—</span>`}</td></tr>`,
        )
        .join("");

      const peopleRows = rep.people
        .map(
          (x) => `<tr><td>${esc(x.email)}${x.githubLogin ? "" : ` <span class="badge">no GitHub login</span>`}</td><td>${esc(x.team ?? "")}</td>
            <td class="n">${fmtUsd(x.spendCents)}</td><td class="n">${x.githubLogin ? x.mergedPrs : `<span class="muted">—</span>`}</td><td class="n">${perPr(x)}</td></tr>`,
        )
        .join("");

      res.send(
        page(
          "Return on spend",
          p,
          `${flash(req)}<h1>Admin</h1>${adminTabs("/admin/roi")}
          <div class="card"><h2>Return on spend: ${esc(monthName(period))}</h2>
            <p class="muted">${picker}</p>
            ${freshness}
            <div class="grid">${tiles
              .map(([k, v, sub]) => `<div><div class="muted" style="font-size:13px">${k}</div><div class="big">${esc(v)}</div><div class="muted" style="font-size:13px">${esc(sub)}</div></div>`)
              .join("")}</div>
            ${
              rep.org.unlinkedSpenders
                ? `<p>${rep.org.unlinkedSpenders} ${rep.org.unlinkedSpenders === 1 ? "person" : "people"} spent ${fmtUsd(rep.org.unlinkedSpendCents)} without a GitHub login in Dev Hub, so their PRs aren't counted and their spend is left out of the per-PR figures. <a href="/admin/people">Add their GitHub logins</a>.</p>`
                : ""
            }
            <p class="muted">Merged PRs are a rough signal of output, not a measure of anyone's productivity: PRs differ in size and difficulty, and spend isn't the only thing that changes how much ships. Use this to spot trends and outliers worth a conversation, not to rank people.</p>
            <p>${
              sync.output.enabled
                ? `<form method="post" action="/admin/roi/refresh" style="display:inline">${csrfField(p)}<input type="hidden" name="period" value="${esc(period)}"><button class="ghost">Recount PRs now</button></form> `
                : ""
            }<a href="/api/admin/roi?format=csv&period=${esc(period)}">Download CSV</a></p>
          </div>
          <div class="card scroll"><h2>By team</h2>
            <table><thead><tr><th>Team</th><th class="n">People</th><th class="n">Spend</th><th class="n">Merged PRs</th><th class="n">Per PR</th><th class="n">Share of spend / PRs</th></tr></thead>
            <tbody>${teamRows || `<tr><td colspan="6" class="muted">No spend or PRs this month.</td></tr>`}</tbody></table>
            <p class="muted">A team with a much larger share of spend than of PRs may be doing work PRs don't capture (design, migrations, reviews), or may have room to use AI tools more effectively.</p></div>
          <div class="card scroll"><h2>Last 6 months</h2>
            <table><thead><tr><th>Month</th><th class="n">Spend</th><th class="n">Merged PRs (Dev Hub people)</th><th class="n">Per PR</th><th class="n">Merged PRs (whole org)</th></tr></thead>
            <tbody>${trendRows}</tbody></table></div>
          <div class="card scroll"><details><summary><b>By person</b> (handle with care)</summary>
            <p class="muted">Individual numbers are noisy and easy to misread. Share them with the person, not as a leaderboard.</p>
            <table><thead><tr><th>Person</th><th>Team</th><th class="n">Spend</th><th class="n">Merged PRs</th><th class="n">Per PR</th></tr></thead>
            <tbody>${peopleRows || `<tr><td colspan="5" class="muted">No one yet.</td></tr>`}</tbody></table></details></div>`,
        ),
      );
    }),
  );

  r.post(
    "/admin/roi/refresh",
    wrap(async (req, res) => {
      const p = adminGuard(req, res);
      if (!p) return;
      const period = PERIOD_RE.test(String(req.body.period ?? "")) ? String(req.body.period) : currentPeriod();
      await act(res, `/admin/roi?period=${period}`, async () => {
        if (!sync.output.enabled) return "GitHub isn't configured.";
        // Search is rate-limited (about 30 calls a minute), so count in the background.
        sync.output.refresh(period).catch((e) => console.error("output refresh failed", e));
        return "Counting merged PRs in the background. Reload in a few minutes (about 2 seconds per person).";
      });
    }),
  );

  return r;
}
