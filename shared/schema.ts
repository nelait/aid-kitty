import { pgTable, text, integer, real, boolean, timestamp, json } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';

// Users table
export const users = pgTable('users', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  username: text('username').notNull().unique(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Projects table
export const projects = pgTable('projects', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  requirements: text('requirements'), // Original requirements text
  status: text('status', { enum: ['draft', 'processing', 'completed', 'failed'] }).default('draft'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Generated plans table
export const generatedPlans = pgTable('generated_plans', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  model: text('model').notNull(), // openai, anthropic, google, deepseek
  planType: text('plan_type', {
    enum: ['executive_summary', 'technical_spec', 'architecture', 'implementation', 'full_mvp']
  }).notNull(),
  content: text('content').notNull(),
  tokensUsed: integer('tokens_used'),
  generationTime: real('generation_time'), // in seconds
  createdAt: timestamp('created_at').defaultNow(),
});

// File uploads table
export const fileUploads = pgTable('file_uploads', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  originalName: text('original_name').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  extractedText: text('extracted_text'), // For PDF text extraction
  uploadPath: text('upload_path').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

// API keys table (encrypted storage)
export const apiKeys = pgTable('api_keys', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(), // 'openai', 'anthropic', 'google', 'deepseek'
  key: text('key').notNull(),
  name: text('name'), // User-friendly name for the key
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Chat sessions table
export const chatSessions = pgTable('chat_sessions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  model: text('model').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Chat messages table
export const chatMessages = pgTable('chat_messages', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  projectId: text('project_id').references(() => projects.id),
  provider: text('provider').notNull(),
  role: text('role').notNull(), // 'user' | 'assistant' | 'system'
  content: text('content').notNull(),
  metadata: text('metadata'), // JSON string for additional data
  createdAt: timestamp('created_at').defaultNow(),
});

// Chat templates table
export const chatTemplates = pgTable('chat_templates', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  content: text('content').notNull(),
  category: text('category', {
    enum: ['coaching', 'brainstorming', 'technical', 'business', 'analysis', 'custom']
  }).default('custom'),
  tags: json('tags').$type<string[]>().default([]),
  isPublic: boolean('is_public').default(false),
  usageCount: integer('usage_count').default(0),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Generated documents table
export const generatedDocuments = pgTable('generated_documents', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  model: text('model').notNull(), // openai, anthropic, google, deepseek
  documentType: text('document_type', {
    enum: ['prd', 'requirements', 'techstack', 'frontend', 'backend', 'flow', 'status']
  }).notNull(),
  content: text('content').notNull(),
  tokensUsed: integer('tokens_used'),
  generationTime: real('generation_time'), // in seconds
  createdAt: timestamp('created_at').defaultNow(),
});

// GitHub settings table
export const githubSettings = pgTable('github_settings', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text('access_token').notNull(), // Personal Access Token
  username: text('username'), // GitHub username
  defaultRepo: text('default_repo'), // owner/repo format
  defaultBranch: text('default_branch').default('main'),
  defaultPath: text('default_path').default('docs'), // Default folder path for documents
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// OpenHands settings table
export const openhandsSettings = pgTable('openhands_settings', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  apiKey: text('api_key').notNull(), // OpenHands Cloud API key
  defaultRepo: text('default_repo'), // owner/repo format
  defaultBranch: text('default_branch').default('main'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// OpenHands builds table (tracks conversations/builds)
export const openhandsBuilds = pgTable('openhands_builds', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionId: text('session_id'), // Reference to prompt builder session
  conversationId: text('conversation_id').notNull(), // OpenHands conversation ID
  repository: text('repository').notNull(), // owner/repo
  prompt: text('prompt').notNull(), // The prompt that was sent
  status: text('status', { enum: ['started', 'running', 'completed', 'failed', 'unknown'] }).default('started'),
  conversationUrl: text('conversation_url'), // Link to OpenHands Cloud
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Estimation settings table
export const estimationSettings = pgTable('estimation_settings', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),

  // Function Point Analysis Configuration
  complexityWeights: json('complexity_weights').$type<{
    simple: number;
    average: number;
    complex: number;
  }>().notNull(),

  functionTypes: json('function_types').$type<{
    externalInputs: { simple: number; average: number; complex: number };
    externalOutputs: { simple: number; average: number; complex: number };
    externalInquiries: { simple: number; average: number; complex: number };
    internalLogicalFiles: { simple: number; average: number; complex: number };
    externalInterfaceFiles: { simple: number; average: number; complex: number };
  }>().notNull(),

  // Environmental Factors (0-5 scale)
  environmentalFactors: json('environmental_factors').$type<{
    dataCommunications: number;
    distributedDataProcessing: number;
    performance: number;
    heavilyUsedConfiguration: number;
    transactionRate: number;
    onlineDataEntry: number;
    endUserEfficiency: number;
    onlineUpdate: number;
    complexProcessing: number;
    reusability: number;
    installationEase: number;
    operationalEase: number;
    multipleSites: number;
    facilitateChange: number;
  }>().notNull(),

  // Project Parameters
  projectParameters: json('project_parameters').$type<{
    teamProductivity: number; // Function Points per person-day
    bufferPercentage: number; // Risk buffer (%)
    hourlyRate: number; // Cost per hour
    hoursPerDay: number; // Working hours per day
    workingDaysPerMonth: number; // Working days per month
  }>().notNull(),

  isDefault: boolean('is_default').default(false),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Prompt Builder tables
export const promptTemplates = pgTable('prompt_templates', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  applicationType: text('application_type', {
    enum: ['web', 'mobile', 'rag', 'api', 'desktop', 'ml', 'blockchain', 'iot', 'game', 'cli', 'microservice', 'chrome-extension', 'electron', 'pwa']
  }).notNull(),
  category: text('category', {
    enum: ['frontend', 'backend', 'fullstack', 'ai', 'data', 'devops', 'security', 'testing', 'infrastructure']
  }).notNull(),
  tags: json('tags').$type<string[]>().default([]),

  // Detailed configuration as JSON
  guidelines: json('guidelines').$type<GuidelineItem[]>().default([]),
  standards: json('standards').$type<StandardItem[]>().default([]),
  libraries: json('libraries').$type<LibraryItem[]>().default([]),
  architecture: json('architecture').$type<ArchitectureGuidelines>().notNull(),
  security: json('security').$type<SecurityItem[]>().default([]),
  performance: json('performance').$type<PerformanceItem[]>().default([]),
  bestPractices: json('best_practices').$type<BestPracticeItem[]>().default([]),
  testing: json('testing').$type<TestingItem[]>().default([]),
  deployment: json('deployment').$type<DeploymentItem[]>().default([]),
  precautions: json('precautions').$type<PrecautionItem[]>().default([]),
  customSections: json('custom_sections').$type<CustomSection[]>().default([]),

  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const promptBuilderSessions = pgTable('prompt_builder_sessions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  templateId: text('template_id').notNull().references(() => promptTemplates.id, { onDelete: 'cascade' }),
  projectDescription: text('project_description').notNull(),
  selectedFeatures: json('selected_features').$type<string[]>().default([]),
  customRequirements: json('custom_requirements').$type<string[]>().default([]),
  generatedPrompt: text('generated_prompt').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Export types
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type GeneratedPlan = typeof generatedPlans.$inferSelect;
export type NewGeneratedPlan = typeof generatedPlans.$inferInsert;
export type GeneratedDocument = typeof generatedDocuments.$inferSelect;
export type NewGeneratedDocument = typeof generatedDocuments.$inferInsert;
export type FileUpload = typeof fileUploads.$inferSelect;
export type NewFileUpload = typeof fileUploads.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type ChatSession = typeof chatSessions.$inferSelect;
export type NewChatSession = typeof chatSessions.$inferInsert;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;
export type ChatTemplate = typeof chatTemplates.$inferSelect;
export type NewChatTemplate = typeof chatTemplates.$inferInsert;
export type EstimationSetting = typeof estimationSettings.$inferSelect;
export type NewEstimationSetting = typeof estimationSettings.$inferInsert;

// Prompt Builder Types
export type ApplicationType = 'web' | 'mobile' | 'rag' | 'api' | 'desktop' | 'ml' | 'blockchain' | 'iot' | 'game' | 'cli' | 'microservice' | 'chrome-extension' | 'electron' | 'pwa';
export type ApplicationCategory = 'frontend' | 'backend' | 'fullstack' | 'ai' | 'data' | 'devops' | 'security' | 'testing' | 'infrastructure';

export interface GuidelineItem {
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high';
  examples?: string[];
}

export interface StandardItem {
  name: string;
  description: string;
  type: string;
  rules: string[];
  examples?: string[];
}

export interface LibraryItem {
  name: string;
  description: string;
  version?: string;
  category: string;
  required: boolean;
  installation: string;
  usage: string;
  alternatives?: string[];
}

export interface ArchitectureGuidelines {
  pattern: string;
  description: string;
  structure: {
    directories: string[];
    files: string[];
    conventions: string[];
  };
  dataFlow: string;
  stateManagement?: string;
  apiDesign?: string;
}

export interface SecurityItem {
  title: string;
  description: string;
  threat: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  mitigation: string[];
  tools?: string[];
}

export interface PerformanceItem {
  title: string;
  description: string;
  impact: 'low' | 'medium' | 'high';
  optimization: string[];
  metrics: string[];
  tools?: string[];
}

export interface BestPracticeItem {
  title: string;
  description: string;
  category: string;
  implementation: string;
  benefits: string[];
  examples?: string[];
}

export interface TestingItem {
  type: string;
  framework: string;
  description: string;
  coverage: string;
  examples: string[];
}

export interface DeploymentItem {
  platform: string;
  description: string;
  steps: string[];
  configuration: string[];
  monitoring?: string[];
}

export interface PrecautionItem {
  title: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  prevention: string[];
}

export interface CustomSection {
  title: string;
  content: string;
  type: 'text' | 'list' | 'code' | 'checklist';
  order: number;
}

export type PromptTemplate = typeof promptTemplates.$inferSelect;
export type NewPromptTemplate = typeof promptTemplates.$inferInsert;
export type PromptBuilderSession = typeof promptBuilderSessions.$inferSelect;
export type NewPromptBuilderSession = typeof promptBuilderSessions.$inferInsert;
