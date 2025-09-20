-- Migration: Create Prompt Builder tables
-- Created: 2024-01-01

-- Create prompt_templates table
CREATE TABLE IF NOT EXISTS "prompt_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"application_type" text NOT NULL,
	"category" text NOT NULL,
	"tags" text DEFAULT '[]' NOT NULL,
	"guidelines" text DEFAULT '{}' NOT NULL,
	"standards" text DEFAULT '{}' NOT NULL,
	"libraries" text DEFAULT '{}' NOT NULL,
	"architecture" text DEFAULT '{}' NOT NULL,
	"security" text DEFAULT '{}' NOT NULL,
	"performance" text DEFAULT '{}' NOT NULL,
	"testing" text DEFAULT '{}' NOT NULL,
	"deployment" text DEFAULT '{}' NOT NULL,
	"precautions" text DEFAULT '{}' NOT NULL,
	"custom_sections" text DEFAULT '[]' NOT NULL,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL
);

-- Create prompt_builder_sessions table
CREATE TABLE IF NOT EXISTS "prompt_builder_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"template_id" text NOT NULL,
	"project_description" text NOT NULL,
	"selected_features" text DEFAULT '[]' NOT NULL,
	"custom_requirements" text DEFAULT '[]' NOT NULL,
	"generated_prompt" text NOT NULL,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL,
	FOREIGN KEY ("template_id") REFERENCES "prompt_templates"("id") ON UPDATE no action ON DELETE cascade
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_prompt_templates_user_id ON prompt_templates(user_id);
CREATE INDEX IF NOT EXISTS idx_prompt_templates_application_type ON prompt_templates(application_type);
CREATE INDEX IF NOT EXISTS idx_prompt_templates_category ON prompt_templates(category);
CREATE INDEX IF NOT EXISTS idx_prompt_templates_created_at ON prompt_templates(created_at);

CREATE INDEX IF NOT EXISTS idx_prompt_builder_sessions_user_id ON prompt_builder_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_prompt_builder_sessions_template_id ON prompt_builder_sessions(template_id);
CREATE INDEX IF NOT EXISTS idx_prompt_builder_sessions_created_at ON prompt_builder_sessions(created_at);
