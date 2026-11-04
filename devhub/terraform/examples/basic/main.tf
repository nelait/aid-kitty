# Installs Dev Hub into an existing Kubernetes cluster (EKS, GKE, AKS, ...) with an
# ingress controller and cert-manager already set up.

terraform {
  required_version = ">= 1.5"
}

variable "kubeconfig_path" {
  type    = string
  default = "~/.kube/config"
}

variable "oidc_client_secret" {
  type      = string
  sensitive = true
}

variable "devhub_admin_token" {
  type      = string
  sensitive = true
}

variable "devhub_scim_token" {
  type      = string
  sensitive = true
}

variable "claude_admin_key" {
  type      = string
  sensitive = true
}

variable "github_token" {
  type      = string
  sensitive = true
}

variable "database_url" {
  description = "Managed Postgres (RDS, Cloud SQL, ...) for high availability."
  type        = string
  sensitive   = true
}

variable "license_file" {
  description = "Path to the signed license file from your vendor."
  type        = string
}

provider "kubernetes" {
  config_path = pathexpand(var.kubeconfig_path)
}

provider "helm" {
  kubernetes {
    config_path = pathexpand(var.kubeconfig_path)
  }
}

module "devhub" {
  source = "../../modules/devhub"

  image_repository = "ghcr.io/your-org/devhub"
  public_url       = "https://devhub.acme.io"

  ingress = {
    enabled     = true
    class_name  = "nginx"
    annotations = { "cert-manager.io/cluster-issuer" = "letsencrypt" }
  }

  oidc = {
    issuer    = "https://acme.okta.com/oauth2/default"
    client_id = "0oa1example"
  }
  allowed_email_domains      = ["acme.io"]
  default_monthly_budget_usd = 300

  database_type      = "postgres"
  database_url       = var.database_url
  replicas           = 2
  claude_gateway_url = "https://claude-gateway.acme.io"

  connectors = {
    claude  = { mode = "gateway", baseUrl = "https://claude-gateway.acme.io", enforceCaps = true }
    copilot = { org = "acme", apiUrl = "https://api.github.com", seatPriceUsd = { business = 19, enterprise = 39 } }
  }

  secrets = {
    OIDC_CLIENT_SECRET = var.oidc_client_secret
    DEVHUB_ADMIN_TOKEN = var.devhub_admin_token
    DEVHUB_SCIM_TOKEN  = var.devhub_scim_token
    CLAUDE_ADMIN_KEY   = var.claude_admin_key
    GITHUB_TOKEN       = var.github_token
    DEVHUB_LICENSE     = file(var.license_file)
  }
}

output "okta_redirect_uri" {
  value = module.devhub.oidc_redirect_uri
}

output "okta_scim_base_url" {
  value = module.devhub.scim_base_url
}
