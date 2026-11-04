import { HttpError } from "../service.js";
import type { MachineSpec, MachineState, WorkspaceProvider } from "./types.js";

export interface CoderTemplate {
  /** Coder organization ID (or "default"), as Coder's API expects in the path. */
  organization: string;
  /** Name of the Coder template that provisions the machine. */
  template: string;
  /** Disk size, used only for Dev Hub's storage cost estimate. */
  diskGb: number;
}

export function validateCoderTemplate(b: Record<string, unknown>): CoderTemplate {
  const t: CoderTemplate = {
    organization: String(b.organization ?? "default").trim() || "default",
    template: String(b.template ?? "").trim(),
    diskGb: Number(b.diskGb ?? 0),
  };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(t.organization)) throw new HttpError(400, "organization must be a Coder organization ID or name");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(t.template)) throw new HttpError(400, "template must be the name of a Coder template");
  if (!Number.isInteger(t.diskGb) || t.diskGb < 0 || t.diskGb > 2000) throw new HttpError(400, "diskGb must be a whole number from 0 to 2000");
  return t;
}

const STATE: Record<string, MachineState> = {
  pending: "starting",
  starting: "starting",
  running: "running",
  stopping: "stopping",
  stopped: "stopped",
  // A failed or cancelled build leaves nothing running to bill.
  failed: "stopped",
  canceling: "stopping",
  canceled: "stopped",
  deleting: "terminated",
  deleted: "terminated",
};

/**
 * Workspaces through an existing Coder deployment (coder.com). Coder's own templates
 * provision the machine (any cloud or Kubernetes); Dev Hub drives its REST API to create,
 * start, stop and delete workspaces for each person, enforces auto-stop, and charges the
 * template's price to the budget. People must already exist in Coder with the same email.
 */
export class CoderProvider implements WorkspaceProvider {
  kind = "coder";
  usesSetupScript = false;

  constructor(
    private url: string,
    private token: string,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(new URL(`/api/v2${path}`, this.url), {
      method,
      headers: { "Coder-Session-Token": this.token, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        msg = (JSON.parse(text) as { message?: string }).message ?? msg;
      } catch {
        /* keep the raw text */
      }
      throw Object.assign(new Error(`Coder ${method} ${path}: HTTP ${res.status}: ${msg}`), { status: res.status });
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  private async username(email: string): Promise<string> {
    const r = await this.call<{ users?: { username: string; email: string; status?: string }[] }>(
      "GET",
      `/users?q=${encodeURIComponent(email)}&limit=25`,
    );
    const u = (r.users ?? []).find((x) => x.email.toLowerCase() === email.toLowerCase());
    if (!u) throw new HttpError(400, `${email} has no Coder account. Ask your admin to add them to Coder first.`);
    if (u.status === "suspended") throw new HttpError(400, `${email}'s Coder account is suspended.`);
    return u.username;
  }

  async create(raw: Record<string, unknown>, spec: MachineSpec): Promise<string> {
    const t = validateCoderTemplate(raw);
    const tpl = await this.call<{ id: string }>("GET", `/organizations/${encodeURIComponent(t.organization)}/templates/${encodeURIComponent(t.template)}`);
    const user = await this.username(spec.ownerEmail);
    const ws = await this.call<{ id: string }>("POST", `/users/${encodeURIComponent(user)}/workspaces`, { name: spec.name, template_id: tpl.id });
    return ws.id;
  }

  private build(id: string, transition: "start" | "stop" | "delete") {
    return this.call("POST", `/workspaces/${encodeURIComponent(id)}/builds`, { transition });
  }

  async start(id: string) {
    await this.build(id, "start");
  }

  async stop(id: string) {
    await this.build(id, "stop");
  }

  async destroy(id: string) {
    try {
      await this.build(id, "delete");
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e;
    }
  }

  async describe(ids: string[]): Promise<Map<string, MachineState>> {
    const out = new Map<string, MachineState>();
    for (const id of ids) {
      try {
        const ws = await this.call<{ latest_build?: { status?: string } }>("GET", `/workspaces/${encodeURIComponent(id)}`);
        out.set(id, STATE[ws.latest_build?.status ?? ""] ?? "starting");
      } catch (e) {
        if ((e as { status?: number }).status !== 404) throw e; // deleted in Coder: gone
      }
    }
    return out;
  }

  connectHint(_id: string, name: string): string {
    return [
      `# Once: install the Coder CLI, then`,
      `coder login ${this.url}`,
      `coder config-ssh`,
      `# Then connect (or use VS Code Remote-SSH with host coder.${name}):`,
      `ssh coder.${name}`,
    ].join("\n");
  }
}
