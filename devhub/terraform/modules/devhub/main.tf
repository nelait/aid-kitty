locals {
  host        = regex("^https?://([^/:]+)", var.public_url)[0]
  secret_name = var.existing_secret != "" ? var.existing_secret : "${var.release_name}-secrets"
  namespace   = var.create_namespace ? kubernetes_namespace.this[0].metadata[0].name : var.namespace

  values = {
    image = {
      repository = var.image_repository
      tag        = var.image_tag
    }
    database     = { type = var.database_type }
    replicaCount = var.replicas
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
  data = merge(var.secrets, var.database_url != "" ? { DATABASE_URL = var.database_url } : {})

  lifecycle {
    precondition {
      condition     = var.database_type != "postgres" || var.database_url != "" || contains(keys(var.secrets), "DATABASE_URL")
      error_message = "database_type = postgres needs database_url (or DATABASE_URL in secrets, or an existing_secret that has it)."
    }
  }
}

resource "helm_release" "devhub" {
  lifecycle {
    precondition {
      condition     = var.database_type == "postgres" || var.replicas == 1
      error_message = "SQLite supports one replica; set database_type = postgres to run more."
    }
  }

  name      = var.release_name
  namespace = local.namespace
  chart     = coalesce(var.chart_path, "${path.module}/../../../charts/devhub")
  values    = [yamlencode(local.values), yamlencode(var.extra_values)]

  # Recreate strategy + one replica: wait for the new pod before reporting success.
  wait    = true
  timeout = 600

  depends_on = [kubernetes_secret.this]
}
