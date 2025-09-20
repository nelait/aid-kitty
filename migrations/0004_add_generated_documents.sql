CREATE TABLE `generated_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`model` text NOT NULL,
	`document_type` text NOT NULL,
	`content` text NOT NULL,
	`tokens_used` integer,
	`generation_time` real,
	`created_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
