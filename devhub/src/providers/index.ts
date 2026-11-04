import type { Config } from "../config.js";
import { HttpError } from "../service.js";
import { AwsProvider, validateAwsTemplate } from "./aws.js";
import { CoderProvider, validateCoderTemplate } from "./coder.js";
import { GcpProvider, validateGcpTemplate } from "./gcp.js";
import type { WorkspaceProvider } from "./types.js";

export type { MachineSpec, MachineState, WorkspaceProvider } from "./types.js";

export const PROVIDER_LABELS: Record<string, string> = { aws: "AWS EC2", gcp: "Google Compute Engine", coder: "Coder" };

/** Validate and normalise a template's provider-specific settings. */
export function validateTemplateConfig(kind: string, raw: Record<string, unknown>): Record<string, unknown> & { diskGb: number } {
  switch (kind) {
    case "aws":
      return { ...validateAwsTemplate(raw) };
    case "gcp":
      return { ...validateGcpTemplate(raw) };
    case "coder":
      return { ...validateCoderTemplate(raw) };
    default:
      throw new HttpError(400, `unknown provider ${kind}; use aws, gcp or coder`);
  }
}

/** The providers this install is configured for. */
export function buildProviders(cfg: Config): WorkspaceProvider[] {
  const w = cfg.workspaces;
  const out: WorkspaceProvider[] = [];
  if (w?.aws) out.push(new AwsProvider(w.aws.region));
  if (w?.gcp) out.push(new GcpProvider(w.gcp.project));
  if (w?.coder) out.push(new CoderProvider(w.coder.url, w.coder.token));
  return out;
}
