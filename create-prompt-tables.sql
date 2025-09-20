-- Create prompt_templates table if it doesn't exist
CREATE TABLE IF NOT EXISTS `prompt_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`application_type` text NOT NULL,
	`category` text NOT NULL,
	`tags` text DEFAULT '[]',
	`guidelines` text DEFAULT '[]',
	`standards` text DEFAULT '[]',
	`libraries` text DEFAULT '[]',
	`architecture` text NOT NULL,
	`security` text DEFAULT '[]',
	`performance` text DEFAULT '[]',
	`best_practices` text DEFAULT '[]',
	`testing` text DEFAULT '[]',
	`deployment` text DEFAULT '[]',
	`precautions` text DEFAULT '[]',
	`custom_sections` text DEFAULT '[]',
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);

-- Create prompt_builder_sessions table if it doesn't exist
CREATE TABLE IF NOT EXISTS `prompt_builder_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`template_id` text NOT NULL,
	`project_description` text NOT NULL,
	`selected_features` text DEFAULT '[]',
	`custom_requirements` text DEFAULT '[]',
	`generated_prompt` text NOT NULL,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_id`) REFERENCES `prompt_templates`(`id`) ON UPDATE no action ON DELETE cascade
);

-- Fix chat_messages table if needed
PRAGMA foreign_keys=OFF;

-- Check if chat_messages has the old schema and fix it
DROP TABLE IF EXISTS `chat_messages_backup`;
CREATE TABLE `chat_messages_backup` AS SELECT * FROM `chat_messages`;

DROP TABLE IF EXISTS `chat_messages`;
CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text,
	`provider` text NOT NULL DEFAULT 'openai',
	`role` text NOT NULL,
	`content` text NOT NULL,
	`metadata` text,
	`created_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);

PRAGMA foreign_keys=ON;
