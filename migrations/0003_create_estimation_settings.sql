CREATE TABLE IF NOT EXISTS "estimation_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"complexity_weights" text NOT NULL,
	"function_types" text NOT NULL,
	"environmental_factors" text NOT NULL,
	"project_parameters" text NOT NULL,
	"is_default" integer DEFAULT false,
	"created_at" text DEFAULT CURRENT_TIMESTAMP,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);
