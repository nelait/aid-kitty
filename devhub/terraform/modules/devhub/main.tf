locals {
  host        = regex("^https?://([^/:]+)", var.public_url)[0]
  secret_name = var.existing_secret != "" ? var.existing_secret : "${var.release_name}-secrets"
  namespace   = var.create_namespace ? kubernetes_namespace.this[0].metadata[0].name : var.namespace

  values = {
    image = {
      repository = var.image_repository
      tag        = var.image_tag
    }
    persistence = {
      enabled      = true
      size         = var.storage_size
      storageClass = var.storage_class
    }
    config = {
      publicUrl        = var.public_url
      claudeGatewayUrl = var.claude_gateway_url
      auth = {
        oidc = {
          issuer      = var.oidc.issuer
          clientId    = var.oidc.client_id
          adminGroup  = var.oidc.admin_group
          groupsClaim = var.oidc.groups_claim
        }
        devLogin            = false
        jitProvisioning     = true
        allowedEmailDomains = var.allowed_email_domains
      }
      wallet = {
        defaultMonthlyBudgetUsd = var.default_monthly_budget_usd
        warnAt                  = 0.8
      }
      connectors          = var.connectors
      syncIntervalSeconds = 300
    }
    secrets = {
      existingSecret = local.secret_name
    }
    ingress = {
      enabled     = var.ingress.enabled
      className   = var.ingress.class_name
      annotations = var.ingress.annotations
      host        = local.host
      tls = {
        enabled    = startswith(var.public_url, "https://")
        secretName = var.ingress.tls_secret_name
      }
    }
  }
}

resource "kubernetes_namespace" "this" {
  count = var.create_namespace ? 1 : 0
  metadata {
    name = var.namespace
  }
}

resource "kubernetes_secret" "this" {
  count = var.existing_secret == "" ? 1 : 0
  metadata {
    name      = local.secret_name
    namespace = local.namespace
  }
  data = var.secrets
}

resource "helm_release" "devhub" {
  name      = var.release_name
  namespace = local.namespace
  chart     = coalesce(var.chart_path, "${path.module}/../../../charts/devhub")
  values    = [yamlencode(local.values), yamlencode(var.extra_values)]

  # Recreate strategy + one replica: wait for the new pod before reporting success.
  wait    = true
  timeout = 600

  depends_on = [kubernetes_secret.this]
}
