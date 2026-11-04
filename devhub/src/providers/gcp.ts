import { InstancesClient } from "@google-cloud/compute";
import { HttpError } from "../service.js";
import type { MachineSpec, MachineState, WorkspaceProvider } from "./types.js";

export interface GcpTemplate {
  zone: string;
  machineType: string;
  /** Image or image family URL, e.g. projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64 */
  image: string;
  /** Subnetwork, e.g. regions/us-central1/subnetworks/dev (no external IP is ever attached). */
  subnetwork: string;
  diskGb: number;
  /** Optional service account for the VM; omitted means no service account at all. */
  serviceAccount?: string;
}

const RE = {
  zone: /^[a-z]+-[a-z]+\d+-[a-z]$/,
  machineType: /^[a-z0-9]+-[a-z0-9-]+$/,
  image: /^(projects\/[a-z0-9-]+\/global\/images\/(family\/)?[a-z0-9-]+)$/,
  subnetwork: /^(projects\/[a-z0-9-]+\/)?regions\/[a-z]+-[a-z]+\d+\/subnetworks\/[a-z0-9-]+$/,
  serviceAccount: /^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/,
};

export function validateGcpTemplate(b: Record<string, unknown>): GcpTemplate {
  const s = (k: string) => String(b[k] ?? "").trim();
  const t: GcpTemplate = {
    zone: s("zone"),
    machineType: s("machineType"),
    image: s("image"),
    subnetwork: s("subnetwork"),
    diskGb: Number(b.diskGb ?? 50),
  };
  if (s("serviceAccount")) t.serviceAccount = s("serviceAccount");
  if (!RE.zone.test(t.zone)) throw new HttpError(400, "zone must look like us-central1-a");
  if (!RE.machineType.test(t.machineType)) throw new HttpError(400, "machineType must look like e2-standard-4");
  if (!RE.image.test(t.image)) throw new HttpError(400, "image must look like projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64");
  if (!RE.subnetwork.test(t.subnetwork)) throw new HttpError(400, "subnetwork must look like regions/us-central1/subnetworks/dev");
  if (t.serviceAccount && !RE.serviceAccount.test(t.serviceAccount)) throw new HttpError(400, "serviceAccount must be a service account email");
  if (!Number.isInteger(t.diskGb) || t.diskGb < 10 || t.diskGb > 2000) throw new HttpError(400, "diskGb must be a whole number from 10 to 2000");
  return t;
}

const STATE: Record<string, MachineState> = {
  PENDING: "starting",
  PROVISIONING: "starting",
  STAGING: "starting",
  RUNNING: "running",
  REPAIRING: "running",
  STOPPING: "stopping",
  PENDING_STOP: "stopping",
  SUSPENDING: "stopping",
  DEPROVISIONING: "stopping",
  STOPPED: "stopped",
  SUSPENDED: "stopped",
  // On Compute Engine, TERMINATED means stopped (the disk is kept), not deleted.
  TERMINATED: "stopped",
};

/** The part of the Compute Engine client Dev Hub uses (so tests can pass a fake). */
export interface InstancesApi {
  insert(req: { project: string; zone: string; instanceResource: Record<string, unknown> }): Promise<unknown>;
  start(req: { project: string; zone: string; instance: string }): Promise<unknown>;
  stop(req: { project: string; zone: string; instance: string }): Promise<unknown>;
  delete(req: { project: string; zone: string; instance: string }): Promise<unknown>;
  get(req: { project: string; zone: string; instance: string }): Promise<[{ status?: string | null }, ...unknown[]]>;
}

const isNotFound = (e: unknown) => {
  const err = e as { code?: number | string; status?: number };
  return err?.code === 404 || err?.code === 5 || err?.status === 404 || err?.code === "NOT_FOUND";
};

/** Label values: lowercase letters, digits, - and _, at most 63 characters. */
const label = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 63);

/**
 * Workspaces as Compute Engine VMs in the customer's GCP project. Credentials come from
 * Application Default Credentials (Workload Identity on GKE), so no keys are stored. VMs
 * get no external IP and run as Shielded VMs; developers connect through IAP TCP forwarding.
 * Machine IDs are "<zone>/<instance name>".
 */
export class GcpProvider implements WorkspaceProvider {
  kind = "gcp";
  usesSetupScript = true;

  constructor(
    private project: string,
    private api: InstancesApi = new InstancesClient() as unknown as InstancesApi,
  ) {}

  private split(machineId: string) {
    const [zone, instance] = machineId.split("/");
    if (!zone || !instance) throw new Error(`bad GCP machine id ${machineId}`);
    return { project: this.project, zone, instance };
  }

  async create(raw: Record<string, unknown>, spec: MachineSpec): Promise<string> {
    const t = validateGcpTemplate(raw);
    const name = `devhub-${spec.workspaceId}-${spec.name}`.slice(0, 63).replace(/-+$/, "");
    const op = (await this.api.insert({
      project: this.project,
      zone: t.zone,
      instanceResource: {
        name,
        machineType: `zones/${t.zone}/machineTypes/${t.machineType}`,
        disks: [
          {
            boot: true,
            autoDelete: true,
            initializeParams: { sourceImage: t.image, diskSizeGb: String(t.diskGb), diskType: `zones/${t.zone}/diskTypes/pd-balanced` },
          },
        ],
        // No accessConfigs: the VM gets no external IP.
        networkInterfaces: [{ subnetwork: t.subnetwork }],
        serviceAccounts: t.serviceAccount ? [{ email: t.serviceAccount, scopes: ["https://www.googleapis.com/auth/cloud-platform"] }] : [],
        shieldedInstanceConfig: { enableSecureBoot: true, enableVtpm: true, enableIntegrityMonitoring: true },
        metadata: { items: [{ key: "startup-script", value: spec.userData }, { key: "block-project-ssh-keys", value: "TRUE" }] },
        labels: { "managed-by": "devhub", "devhub-workspace-id": String(spec.workspaceId), "devhub-owner": label(spec.ownerEmail) },
        tags: { items: ["devhub-workspace"] },
      },
    })) as [{ promise?: () => Promise<unknown> }] | undefined;
    // insert returns a long-running operation; wait for it so errors (quota, bad image) surface here.
    if (Array.isArray(op) && typeof op[0]?.promise === "function") await op[0].promise();
    return `${t.zone}/${name}`;
  }

  async start(id: string) {
    await this.api.start(this.split(id));
  }

  async stop(id: string) {
    await this.api.stop(this.split(id));
  }

  async destroy(id: string) {
    try {
      await this.api.delete(this.split(id));
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }

  async describe(ids: string[]): Promise<Map<string, MachineState>> {
    const out = new Map<string, MachineState>();
    for (const id of ids) {
      try {
        const [inst] = await this.api.get(this.split(id));
        out.set(id, STATE[String(inst.status ?? "")] ?? "starting");
      } catch (e) {
        if (!isNotFound(e)) throw e; // a missing VM stays out of the map: it's gone
      }
    }
    return out;
  }

  connectHint(id: string, name: string): string {
    const { zone, instance } = this.split(id);
    return [
      `# ~/.ssh/config  (needs the gcloud CLI and the IAP-secured Tunnel User role in ${this.project})`,
      `Host devhub-${name}`,
      `  HostName ${instance}`,
      `  User dev`,
      `  ProxyCommand gcloud compute start-iap-tunnel %h 22 --listen-on-stdin --project ${this.project} --zone ${zone}`,
    ].join("\n");
  }
}
