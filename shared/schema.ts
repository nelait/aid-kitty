import { sqliteTable, text, integer, real, blob } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';

// Users table
export const users = sqliteTable('users', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  username: text('username').notNull().unique(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

// Projects table
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  requirements: text('requirements'), // Original requirements text
  status: text('status', { enum: ['draft', 'processing', 'completed', 'failed'] }).default('draft'),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

// Generated plans table
export const generatedPlans = sqliteTable('generated_plans', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  model: text('model').notNull(), // openai, anthropic, google, deepseek
  planType: text('plan_type', { 
    enum: ['executive_summary', 'technical_spec', 'architecture', 'implementation', 'full_mvp'] 
  }).notNull(),
  content: text('content').notNull(),
  tokensUsed: integer('tokens_used'),
  generationTime: real('generation_time'), // in seconds
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

// File uploads table
export const fileUploads = sqliteTable('file_uploads', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  originalName: text('original_name').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  extractedText: text('extracted_text'), // For PDF text extraction
  uploadPath: text('upload_path').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

// API keys table (encrypted storage)
export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(), // 'openai', 'anthropic', 'google', 'deepseek'
  key: text('key').notNull(),
  name: text('name'), // User-friendly name for the key
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

// Chat sessions table
export const chatSessions = sqliteTable('chat_sessions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  model: text('model').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

// Chat messages table
export const chatMessages = sqliteTable('chat_messages', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  projectId: text('project_id').references(() => projects.id),
  provider: text('provider').notNull(),
  role: text('role').notNull(), // 'user' | 'assistant' | 'system'
  content: text('content').notNull(),
  metadata: text('metadata'), // JSON string for additional data
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

// Chat templates table
export const chatTemplates = sqliteTable('chat_templates', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  content: text('content').notNull(),
  category: text('category', {
    enum: ['coaching', 'brainstorming', 'technical', 'business', 'analysis', 'custom']
  }).default('custom'),
  tags: text('tags', { mode: 'json' }).$type<string[]>().default([]),
  isPublic: integer('is_public', { mode: 'boolean' }).default(false),
  usageCount: integer('usage_count').default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

// Generated documents table
export const generatedDocuments = sqliteTable('generated_documents', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  model: text('model').notNull(), // openai, anthropic, google, deepseek
  documentType: text('document_type', { 
    enum: ['prd', 'requirements', 'techstack', 'frontend', 'backend', 'flow', 'status'] 
  }).notNull(),
  content: text('content').notNull(),
  tokensUsed: integer('tokens_used'),
  generationTime: real('generation_time'), // in seconds
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

// Estimation settings table
export const estimationSettings = sqliteTable('estimation_settings', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  
  // Function Point Analysis Configuration
  complexityWeights: text('complexity_weights', { mode: 'json' }).$type<{
    simple: number;
    average: number;
    complex: number;
  }>().notNull(),
  
  functionTypes: text('function_types', { mode: 'json' }).$type<{
    externalInputs: { simple: number; average: number; complex: number };
    externalOutputs: { simple: number; average: number; complex: number };
    externalInquiries: { simple: number; average: number; complex: number };
    internalLogicalFiles: { simple: number; average: number; complex: number };
    externalInterfaceFiles: { simple: number; average: number; complex: number };
  }>().notNull(),
  
  // Environmental Factors (0-5 scale)
  environmentalFactors: text('environmental_factors', { mode: 'json' }).$type<{
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
  projectParameters: text('project_parameters', { mode: 'json' }).$type<{
    teamProductivity: number; // Function Points per person-day
    bufferPercentage: number; // Risk buffer (%)
    hourlyRate: number; // Cost per hour
    hoursPerDay: number; // Working hours per day
    workingDaysPerMonth: number; // Working days per month
  }>().notNull(),
  
  isDefault: integer('is_default', { mode: 'boolean' }).default(false),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
});

// Prompt Builder tables
export const promptTemplates = sqliteTable('prompt_templates', {
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
  tags: text('tags', { mode: 'json' }).$type<string[]>().default([]),
  
  // Detailed configuration as JSON
  guidelines: text('guidelines', { mode: 'json' }).$type<GuidelineItem[]>().default([]),
  standards: text('standards', { mode: 'json' }).$type<StandardItem[]>().default([]),
  libraries: text('libraries', { mode: 'json' }).$type<LibraryItem[]>().default([]),
  architecture: text('architecture', { mode: 'json' }).$type<ArchitectureGuidelines>().notNull(),
  security: text('security', { mode: 'json' }).$type<SecurityItem[]>().default([]),
  performance: text('performance', { mode: 'json' }).$type<PerformanceItem[]>().default([]),
  bestPractices: text('best_practices', { mode: 'json' }).$type<BestPracticeItem[]>().default([]),
  testing: text('testing', { mode: 'json' }).$type<TestingItem[]>().default([]),
  deployment: text('deployment', { mode: 'json' }).$type<DeploymentItem[]>().default([]),
  precautions: text('precautions', { mode: 'json' }).$type<PrecautionItem[]>().default([]),
  customSections: text('custom_sections', { mode: 'json' }).$type<CustomSection[]>().default([]),
  
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

export const promptBuilderSessions = sqliteTable('prompt_builder_sessions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  templateId: text('template_id').notNull().references(() => promptTemplates.id, { onDelete: 'cascade' }),
  projectDescription: text('project_description').notNull(),
  selectedFeatures: text('selected_features', { mode: 'json' }).$type<string[]>().default([]),
  customRequirements: text('custom_requirements', { mode: 'json' }).$type<string[]>().default([]),
  generatedPrompt: text('generated_prompt').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
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
