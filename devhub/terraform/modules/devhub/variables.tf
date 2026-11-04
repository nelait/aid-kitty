variable "namespace" {
  description = "Namespace to install Dev Hub into."
  type        = string
  default     = "devhub"
}

variable "create_namespace" {
  description = "Create the namespace."
  type        = bool
  default     = true
}

variable "release_name" {
  description = "Helm release name."
  type        = string
  default     = "devhub"
}

variable "chart_path" {
  description = "Path to the Dev Hub Helm chart."
  type        = string
  default     = null
}

variable "image_repository" {
  description = "Container image repository for Dev Hub."
  type        = string
}

variable "image_tag" {
  description = "Image tag. Defaults to the chart's appVersion."
  type        = string
  default     = ""
}

variable "public_url" {
  description = "External URL of the portal, e.g. https://devhub.acme.io. Used for OIDC and SCIM URLs."
  type        = string
}

variable "ingress" {
  description = "Ingress settings. Set enabled = false to expose the Service another way."
  type = object({
    enabled         = bool
    class_name      = optional(string, "")
    annotations     = optional(map(string), {})
    tls_secret_name = optional(string, "devhub-tls")
  })
  default = { enabled = true }
}

variable "oidc" {
  description = "OIDC (Okta) settings. The client secret goes in var.secrets as OIDC_CLIENT_SECRET."
  type = object({
    issuer       = string
    client_id    = string
    admin_group  = optional(string, "devhub-admins")
    groups_claim = optional(string, "groups")
  })
}

variable "allowed_email_domains" {
  description = "Only these email domains may sign in. Empty allows any domain the IdP vouches for."
  type        = list(string)
  default     = []
}

variable "default_monthly_budget_usd" {
  description = "Per-person monthly AI budget when no team or personal budget is set."
  type        = number
  default     = 300
}

variable "claude_gateway_url" {
  description = "Claude apps gateway URL shown to developers. Empty hides the connect instructions."
  type        = string
  default     = ""
}

variable "connectors" {
  description = "Connector settings (non-secret). Keys: claude, copilot, cursor; see the chart's values.yaml."
  type        = any
  default     = {}
}

variable "secrets" {
  description = <<-EOT
    Secret environment variables, stored in a Kubernetes Secret: OIDC_CLIENT_SECRET, DEVHUB_ADMIN_TOKEN,
    DEVHUB_SCIM_TOKEN, CLAUDE_ADMIN_KEY, GITHUB_TOKEN, CURSOR_API_KEY, DEVHUB_SLACK_WEBHOOK_URL, DEVHUB_LICENSE.
    They are kept in Terraform state; protect the state accordingly, or pass existing_secret instead.
  EOT
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "existing_secret" {
  description = "Name of a Secret you manage (External Secrets, Vault). When set, var.secrets is ignored."
  type        = string
  default     = ""
}

variable "database_type" {
  description = "sqlite (one replica, data on a volume) or postgres (several replicas)."
  type        = string
  default     = "sqlite"
  validation {
    condition     = contains(["sqlite", "postgres"], var.database_type)
    error_message = "database_type must be sqlite or postgres."
  }
}

variable "database_url" {
  description = "postgres://user:pass@host:5432/devhub, when database_type = postgres and existing_secret is not used."
  type        = string
  default     = ""
  sensitive   = true
}

variable "replicas" {
  description = "Number of Dev Hub pods. More than one needs database_type = postgres."
  type        = number
  default     = 1
}

variable "storage_size" {
  description = "Size of the data volume (SQLite)."
  type        = string
  default     = "2Gi"
}

variable "storage_class" {
  description = "StorageClass for the data volume. Empty uses the cluster default."
  type        = string
  default     = ""
}

variable "extra_values" {
  description = "Additional Helm values merged last (YAML-compatible map)."
  type        = any
  default     = {}
}
