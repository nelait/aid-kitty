-- Consolidated PostgreSQL migration
-- Drop existing tables if they exist to start fresh
DROP TABLE IF EXISTS "api_keys" CASCADE;
DROP TABLE IF EXISTS "chat_messages" CASCADE;
DROP TABLE IF EXISTS "chat_sessions" CASCADE;
DROP TABLE IF EXISTS "file_uploads" CASCADE;
DROP TABLE IF EXISTS "generated_plans" CASCADE;
DROP TABLE IF EXISTS "generated_documents" CASCADE;
DROP TABLE IF EXISTS "projects" CASCADE;
DROP TABLE IF EXISTS "users" CASCADE;
DROP TABLE IF EXISTS "estimation_settings" CASCADE;
DROP TABLE IF EXISTS "prompt_templates" CASCADE;
DROP TABLE IF EXISTS "prompt_variables" CASCADE;
DROP TABLE IF EXISTS "chat_templates" CASCADE;

-- Create users table first (referenced by other tables)
CREATE TABLE "users" (
    "id" text PRIMARY KEY NOT NULL,
    "username" text NOT NULL UNIQUE,
    "email" text NOT NULL UNIQUE,
    "password_hash" text NOT NULL,
    "created_at" bigint,
    "updated_at" bigint
);

-- Create projects table
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

-- Create chat_sessions table
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

-- Create chat_messages table
CREATE TABLE "chat_messages" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL,
    "project_id" text,
    "provider" text NOT NULL,
    "role" text NOT NULL,
    "content" text NOT NULL,
    "metadata" text,
    "created_at" bigint,
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON UPDATE no action ON DELETE cascade
);

-- Create file_uploads table
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

-- Create generated_plans table
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

-- Create generated_documents table
CREATE TABLE "generated_documents" (
    "id" text PRIMARY KEY NOT NULL,
    "project_id" text NOT NULL,
    "model" text NOT NULL,
    "document_type" text NOT NULL,
    "content" text NOT NULL,
    "tokens_used" integer,
    "generation_time" real,
    "created_at" bigint,
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON UPDATE no action ON DELETE cascade
);

-- Create api_keys table
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

-- Create estimation_settings table
CREATE TABLE "estimation_settings" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL,
    "name" text NOT NULL,
    "description" text,
    "complexity_weights" text NOT NULL,
    "function_types" text NOT NULL,
    "environmental_factors" text NOT NULL,
    "project_parameters" text NOT NULL,
    "is_default" boolean DEFAULT false,
    "created_at" bigint,
    "updated_at" bigint,
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade
);

-- Create prompt_templates table
CREATE TABLE "prompt_templates" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL,
    "name" text NOT NULL,
    "description" text,
    "content" text NOT NULL,
    "category" text NOT NULL,
    "tags" text,
    "is_public" boolean DEFAULT false,
    "usage_count" integer DEFAULT 0,
    "created_at" bigint,
    "updated_at" bigint,
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade
);

-- Create prompt_variables table
CREATE TABLE "prompt_variables" (
    "id" text PRIMARY KEY NOT NULL,
    "template_id" text NOT NULL,
    "name" text NOT NULL,
    "description" text,
    "type" text NOT NULL,
    "default_value" text,
    "is_required" boolean DEFAULT false,
    "created_at" bigint,
    "updated_at" bigint,
    FOREIGN KEY ("template_id") REFERENCES "prompt_templates"("id") ON UPDATE no action ON DELETE cascade
);

-- Create chat_templates table
CREATE TABLE "chat_templates" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL,
    "name" text NOT NULL,
    "description" text NOT NULL,
    "content" text NOT NULL,
    "category" text NOT NULL,
    "tags" text,
    "is_public" boolean DEFAULT false,
    "usage_count" integer DEFAULT 0,
    "created_at" bigint,
    "updated_at" bigint,
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade
);

-- Create indexes
CREATE UNIQUE INDEX "users_username_unique" ON "users" ("username");
CREATE UNIQUE INDEX "users_email_unique" ON "users" ("email");
