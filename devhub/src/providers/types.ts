/** Normalised workspace machine states, whatever the provider. */
export type MachineState = "starting" | "running" | "stopping" | "stopped" | "terminated";

export interface MachineSpec {
  workspaceId: number;
  name: string;
  ownerEmail: string;
  /** First-boot setup script (cloud-init / startup-script). Providers that provision through their own templates ignore it. */
  userData: string;
}

export interface WorkspaceProvider {
  /** Matches a template's `provider`: "aws", "gcp" or "coder". */
  kind: string;
  /** Whether machines run Dev Hub's setup script (and so need the developer's SSH key). */
  usesSetupScript: boolean;
  create(template: Record<string, unknown>, spec: MachineSpec): Promise<string>;
  start(machineId: string): Promise<void>;
  stop(machineId: string): Promise<void>;
  destroy(machineId: string): Promise<void>;
  /** Current state of each machine; missing ids are gone (treated as terminated). */
  describe(machineIds: string[]): Promise<Map<string, MachineState>>;
  /** How a developer reaches the machine, e.g. an SSH config block. */
  connectHint(machineId: string, workspaceName: string): string;
}
