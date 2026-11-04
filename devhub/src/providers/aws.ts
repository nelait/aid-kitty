import {
  DescribeInstancesCommand,
  EC2Client,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
  type _InstanceType,
} from "@aws-sdk/client-ec2";
import { HttpError } from "../service.js";

/** Normalised workspace machine states, whatever the provider. */
export type MachineState = "starting" | "running" | "stopping" | "stopped" | "terminated";

export interface MachineSpec {
  workspaceId: number;
  name: string;
  ownerEmail: string;
  userData: string;
}

export interface WorkspaceProvider {
  kind: string;
  create(template: Record<string, unknown>, spec: MachineSpec): Promise<string>;
  start(machineId: string): Promise<void>;
  stop(machineId: string): Promise<void>;
  destroy(machineId: string): Promise<void>;
  /** Current state of each machine; missing ids are gone (treated as terminated). */
  describe(machineIds: string[]): Promise<Map<string, MachineState>>;
  /** How a developer reaches the machine, e.g. an SSH config block. */
  connectHint(machineId: string, workspaceName: string): string;
}

export interface AwsTemplate {
  imageId: string;
  instanceType: string;
  subnetId: string;
  securityGroupIds: string[];
  /** Instance profile with AmazonSSMManagedInstanceCore, for Session Manager access. */
  instanceProfile: string;
  diskGb: number;
}

const ID = {
  ami: /^ami-[0-9a-f]{8,17}$/,
  subnet: /^subnet-[0-9a-f]{8,17}$/,
  sg: /^sg-[0-9a-f]{8,17}$/,
  type: /^[a-z0-9]+\.[a-z0-9]+$/,
  profile: /^[\w+=,.@-]{1,128}$/,
};

export function validateAwsTemplate(b: Record<string, unknown>): AwsTemplate {
  const s = (k: string) => String(b[k] ?? "").trim();
  const sgs = (Array.isArray(b.securityGroupIds) ? b.securityGroupIds : String(b.securityGroupIds ?? "").split(/[\s,]+/))
    .map((x) => String(x).trim())
    .filter(Boolean);
  const t: AwsTemplate = {
    imageId: s("imageId"),
    instanceType: s("instanceType"),
    subnetId: s("subnetId"),
    securityGroupIds: sgs,
    instanceProfile: s("instanceProfile"),
    diskGb: Number(b.diskGb ?? 50),
  };
  if (!ID.ami.test(t.imageId)) throw new HttpError(400, "imageId must be an AMI ID like ami-0abc12345def67890");
  if (!ID.type.test(t.instanceType)) throw new HttpError(400, "instanceType must look like t3.xlarge");
  if (!ID.subnet.test(t.subnetId)) throw new HttpError(400, "subnetId must look like subnet-0abc1234");
  if (!t.securityGroupIds.length || !t.securityGroupIds.every((g) => ID.sg.test(g))) {
    throw new HttpError(400, "securityGroupIds must be one or more IDs like sg-0abc1234");
  }
  if (!ID.profile.test(t.instanceProfile)) throw new HttpError(400, "instanceProfile must be an IAM instance profile name");
  if (!Number.isInteger(t.diskGb) || t.diskGb < 8 || t.diskGb > 2000) throw new HttpError(400, "diskGb must be a whole number from 8 to 2000");
  return t;
}

const STATE: Record<string, MachineState> = {
  pending: "starting",
  running: "running",
  stopping: "stopping",
  stopped: "stopped",
  "shutting-down": "terminated",
  terminated: "terminated",
};

/**
 * Workspaces as EC2 instances in the customer's own AWS account. Credentials come from the
 * default chain (an IRSA role for the Dev Hub pod, an instance profile, or env vars), so Dev
 * Hub never stores AWS keys. Instances get no public IP; developers connect through
 * Session Manager. IMDSv2 is required and volumes are encrypted.
 */
export class AwsProvider implements WorkspaceProvider {
  kind = "aws";

  constructor(
    private region: string,
    private ec2: EC2Client = new EC2Client({ region }),
  ) {}

  async create(raw: Record<string, unknown>, spec: MachineSpec): Promise<string> {
    const t = validateAwsTemplate(raw);
    const tags = [
      { Key: "Name", Value: `devhub-${spec.name}` },
      { Key: "devhub:workspace-id", Value: String(spec.workspaceId) },
      { Key: "devhub:owner", Value: spec.ownerEmail },
      { Key: "managed-by", Value: "devhub" },
    ];
    const out = await this.ec2.send(
      new RunInstancesCommand({
        ImageId: t.imageId,
        InstanceType: t.instanceType as _InstanceType,
        MinCount: 1,
        MaxCount: 1,
        UserData: Buffer.from(spec.userData).toString("base64"),
        IamInstanceProfile: { Name: t.instanceProfile },
        NetworkInterfaces: [{ DeviceIndex: 0, SubnetId: t.subnetId, Groups: t.securityGroupIds, AssociatePublicIpAddress: false }],
        BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { VolumeSize: t.diskGb, VolumeType: "gp3", Encrypted: true, DeleteOnTermination: true } }],
        MetadataOptions: { HttpTokens: "required", HttpEndpoint: "enabled" },
        TagSpecifications: [
          { ResourceType: "instance", Tags: tags },
          { ResourceType: "volume", Tags: tags },
        ],
      }),
    );
    const id = out.Instances?.[0]?.InstanceId;
    if (!id) throw new Error("EC2 RunInstances returned no instance ID");
    return id;
  }

  async start(id: string) {
    await this.ec2.send(new StartInstancesCommand({ InstanceIds: [id] }));
  }

  async stop(id: string) {
    await this.ec2.send(new StopInstancesCommand({ InstanceIds: [id] }));
  }

  async destroy(id: string) {
    await this.ec2.send(new TerminateInstancesCommand({ InstanceIds: [id] }));
  }

  async describe(ids: string[]): Promise<Map<string, MachineState>> {
    const out = new Map<string, MachineState>();
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      try {
        const res = await this.ec2.send(new DescribeInstancesCommand({ InstanceIds: batch }));
        for (const r of res.Reservations ?? []) {
          for (const inst of r.Instances ?? []) {
            if (inst.InstanceId) out.set(inst.InstanceId, STATE[inst.State?.Name ?? ""] ?? "starting");
          }
        }
      } catch (e) {
        if ((e as { name?: string }).name !== "InvalidInstanceID.NotFound") throw e;
        // One unknown ID fails the whole call. A single unknown ID means that instance is gone;
        // otherwise retry one at a time so the others still resolve.
        if (batch.length === 1) continue;
        for (const id of batch) for (const [k, v] of await this.describe([id])) out.set(k, v);
      }
    }
    return out;
  }

  connectHint(id: string, name: string): string {
    return [
      `# ~/.ssh/config  (needs the AWS CLI, its Session Manager plugin, and access to ${this.region})`,
      `Host devhub-${name}`,
      `  HostName ${id}`,
      `  User dev`,
      `  ProxyCommand sh -c "aws ssm start-session --region ${this.region} --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p"`,
    ].join("\n");
  }
}
