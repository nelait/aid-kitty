import assert from "node:assert/strict";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { getUserByEmail } from "../src/db.js";
import { SmtpSender } from "../src/notify.js";
import { Client, admin, harness, type Harness } from "./helpers.js";

let h: Harness;
before(async () => {
  h = await harness();
  await admin(h.url, "POST", "/api/admin/teams", { name: "platform", member_default_usd: 100 });
  await admin(h.url, "POST", "/api/admin/users", [
    { email: "lead@acme.io", name: "Priya", team: "platform", role: "manager" },
    { email: "sam@acme.io", name: "Sam", team: "platform" },
    { email: "kim@acme.io", name: "Kim", team: "platform" },
  ]);
});
after(() => h.close());

/** Set someone's Codex spend for this month (a tool with no connector), which re-checks alerts. */
const spend = (rows: Record<string, number>) =>
  admin(h.url, "POST", "/api/admin/spend-import", { tool: "codex", rows: Object.entries(rows).map(([email, usd]) => ({ email, usd })) });

const take = () => h.emails.splice(0, h.emails.length);

test("nothing is sent under the threshold", async () => {
  await spend({ "sam@acme.io": 79 });
  assert.deepEqual(take(), []);
});

test("crossing 80% emails the person once, with a breakdown", async () => {
  await spend({ "sam@acme.io": 85 });
  const sent = take();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ["sam@acme.io"]);
  assert.match(sent[0].subject, /^You've used 85% of your AI budget for /);
  assert.match(sent[0].text, /You've spent \$85\.00 of your \$100\.00 AI budget/);
  assert.match(sent[0].text, /codex: \$85\.00/);
  assert.match(sent[0].text, /\$15\.00 is left/);
  // Re-checking (a sync, another import) doesn't repeat it.
  await h.sync.run();
  await spend({ "sam@acme.io": 90 });
  assert.deepEqual(take(), []);
});

test("using it all up emails the person and their team's managers", async () => {
  await spend({ "sam@acme.io": 100 });
  const sent = take();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].to, ["sam@acme.io"]);
  assert.match(sent[0].subject, /^Your AI budget for .* is used up$/);
  assert.match(sent[0].text, /blocked until the budget resets on .* or an increase is approved/);
  assert.deepEqual(sent[1].to, ["lead@acme.io"]);
  assert.match(sent[1].subject, /^Sam has used their AI budget for /);
  assert.match(sent[1].text, /\/approvals/);
});

test("an approved increase re-arms the alert, so passing 100% again is announced again", async () => {
  const sam = await Client.login(h.url, "sam@acme.io");
  const lead = await Client.login(h.url, "lead@acme.io");
  const rq = await (await sam.post("/api/me/raise-requests", { amount_usd: 20, reason: "release week" })).json();
  await lead.post(`/api/raise-requests/${rq.id}/approve`, {});
  assert.deepEqual(take(), []); // 100 of 120: over 80%, already told; under 100% now
  const alerts = await h.db.all<{ level: string }>(
    "SELECT level FROM budget_alerts WHERE user_id = ? ORDER BY level",
    (await getUserByEmail(h.db, "sam@acme.io"))!.id,
  );
  assert.deepEqual(alerts.map((a) => a.level), ["warning"]);
  await spend({ "sam@acme.io": 125 });
  const sent = take();
  assert.equal(sent.length, 2);
  assert.match(sent[0].subject, /used up/);
});

test("jumping straight past 100% sends one email, not two", async () => {
  await spend({ "sam@acme.io": 125, "kim@acme.io": 150 });
  const sent = take().filter((e) => e.to.includes("kim@acme.io"));
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /used up/);
});

test("a failed send is retried on the next check", async () => {
  const id = (await getUserByEmail(h.db, "lead@acme.io"))!.id;
  const original = h.sync.alerts["email"];
  let fail = true;
  (h.sync.alerts as unknown as { email: { send: (e: unknown) => Promise<void> } }).email = {
    send: async (e) => {
      if (fail) throw new Error("smtp down");
      h.emails.push(e as never);
    },
  };
  try {
    await spend({ "sam@acme.io": 125, "kim@acme.io": 150, "lead@acme.io": 95 });
    assert.deepEqual(take(), []);
    assert.equal((await h.db.all("SELECT * FROM budget_alerts WHERE user_id = ?", id)).length, 0);
    fail = false;
    await h.sync.alerts.check();
    const sent = take();
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, ["lead@acme.io"]);
  } finally {
    (h.sync.alerts as unknown as { email: unknown }).email = original;
  }
});

test("alerts can be switched off", async () => {
  h.cfg.notify.budgetAlerts = false;
  try {
    await h.db.run("DELETE FROM budget_alerts");
    assert.equal(await h.sync.alerts.check(), 0);
    assert.deepEqual(take(), []);
  } finally {
    h.cfg.notify.budgetAlerts = true;
  }
});

test("SmtpSender delivers a message to an SMTP server", async () => {
  const received: string[] = [];
  const server = createServer((sock) => {
    let data = false;
    let buf = "";
    sock.write("220 test ESMTP\r\n");
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (data) {
          if (line === ".") {
            data = false;
            sock.write("250 queued\r\n");
          } else received.push(line);
        } else if (/^(EHLO|HELO)/i.test(line)) sock.write("250 test\r\n");
        else if (/^DATA/i.test(line)) {
          data = true;
          sock.write("354 go\r\n");
        } else if (/^QUIT/i.test(line)) sock.end("221 bye\r\n");
        else sock.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const sender = new SmtpSender(`smtp://127.0.0.1:${port}?ignoreTLS=true`, "Dev Hub <devhub@acme.io>");
    await sender.send({ to: ["sam@acme.io"], subject: "Budget check", text: "Hello from Dev Hub" });
    const msg = received.join("\n");
    assert.match(msg, /^To: sam@acme\.io$/m);
    assert.match(msg, /^Subject: Budget check$/m);
    assert.match(msg, /Hello from Dev Hub/);
  } finally {
    server.close();
  }
});
