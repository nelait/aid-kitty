output "portal_url" {
  description = "Portal URL."
  value       = var.public_url
}

output "oidc_redirect_uri" {
  description = "Redirect URI to register in the Okta app."
  value       = "${var.public_url}/auth/callback"
}

output "scim_base_url" {
  description = "SCIM connector base URL for Okta."
  value       = "${var.public_url}/scim/v2"
}

output "namespace" {
  description = "Namespace Dev Hub runs in."
  value       = local.namespace
}

output "secret_name" {
  description = "Secret holding Dev Hub's credentials."
  value       = local.secret_name
}
