CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"key" text NOT NULL,
	"name" text,
	"is_active" boolean DEFAULT true,
	"created_at" bigint,
	"updated_at" bigint,
	FOREIGN KEY ("user_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade
);

CREATE TABLE "chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"tokens_used" integer,
	"created_at" bigint,
	FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id") ON UPDATE no action ON DELETE cascade
);

CREATE TABLE "chat_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"model" text NOT NULL,
	"created_at" bigint,
	"updated_at" bigint,
	FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY ("user_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade
);

CREATE TABLE "file_uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"filename" text NOT NULL,
	"original_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"upload_path" text NOT NULL,
	"extracted_text" text,
	"created_at" bigint,
	FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON UPDATE no action ON DELETE cascade
);

CREATE TABLE "generated_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"model" text NOT NULL,
	"plan_type" text NOT NULL,
	"content" text NOT NULL,
	"tokens_used" integer,
	"generation_time" real,
	"created_at" bigint,
	FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON UPDATE no action ON DELETE cascade
);

CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"requirements" text,
	"status" text DEFAULT 'draft',
	"created_at" bigint,
	"updated_at" bigint,
	FOREIGN KEY ("user_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade
);

CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" bigint,
	"updated_at" bigint
);

CREATE UNIQUE INDEX "users_username_unique" ON "users" ("username");
CREATE UNIQUE INDEX "users_email_unique" ON "users" ("email");