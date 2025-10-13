-- Add missing columns to prompt_templates table
ALTER TABLE "prompt_templates" 
ADD COLUMN IF NOT EXISTS "application_type" text NOT NULL DEFAULT 'web';

ALTER TABLE "prompt_templates" 
ADD COLUMN IF NOT EXISTS "guidelines" text;

ALTER TABLE "prompt_templates" 
ADD COLUMN IF NOT EXISTS "standards" text;

ALTER TABLE "prompt_templates" 
ADD COLUMN IF NOT EXISTS "libraries" text;

ALTER TABLE "prompt_templates" 
ADD COLUMN IF NOT EXISTS "architecture" text;

ALTER TABLE "prompt_templates" 
ADD COLUMN IF NOT EXISTS "security" text;

ALTER TABLE "prompt_templates" 
ADD COLUMN IF NOT EXISTS "performance" text;

ALTER TABLE "prompt_templates" 
ADD COLUMN IF NOT EXISTS "best_practices" text;

ALTER TABLE "prompt_templates" 
ADD COLUMN IF NOT EXISTS "testing" text;

ALTER TABLE "prompt_templates" 
ADD COLUMN IF NOT EXISTS "deployment" text;

ALTER TABLE "prompt_templates" 
ADD COLUMN IF NOT EXISTS "precautions" text;

ALTER TABLE "prompt_templates" 
ADD COLUMN IF NOT EXISTS "custom_sections" text;

-- Make content column nullable since Prompt Builder uses structured JSON fields instead
ALTER TABLE "prompt_templates" 
ALTER COLUMN "content" DROP NOT NULL;

-- Create prompt_builder_sessions table
CREATE TABLE IF NOT EXISTS "prompt_builder_sessions" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL,
    "template_id" text NOT NULL,
    "project_description" text NOT NULL,
    "selected_features" text,
    "custom_requirements" text,
    "generated_prompt" text NOT NULL,
    "created_at" bigint,
    "updated_at" bigint,
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY ("template_id") REFERENCES "prompt_templates"("id") ON UPDATE no action ON DELETE cascade
);
