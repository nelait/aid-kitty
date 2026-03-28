CREATE TABLE "openhands_builds" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text,
	"conversation_id" text NOT NULL,
	"repository" text NOT NULL,
	"prompt" text NOT NULL,
	"status" text DEFAULT 'started',
	"conversation_url" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "openhands_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"api_key" text NOT NULL,
	"default_repo" text,
	"default_branch" text DEFAULT 'main',
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"marketplace_subscription_id" text NOT NULL,
	"offer_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"status" text DEFAULT 'pending',
	"quantity" integer DEFAULT 1,
	"beneficiary_email" text,
	"beneficiary_id" text,
	"purchaser_email" text,
	"purchaser_id" text,
	"saas_subscription_status" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "subscriptions_marketplace_subscription_id_unique" UNIQUE("marketplace_subscription_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "microsoft_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auth_provider" text DEFAULT 'local';--> statement-breakpoint
ALTER TABLE "openhands_builds" ADD CONSTRAINT "openhands_builds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openhands_settings" ADD CONSTRAINT "openhands_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;