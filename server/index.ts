import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables - only in development
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

// Debug environment variables
console.log('Environment check:');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('OPENAI_API_KEY exists:', !!process.env.OPENAI_API_KEY);
console.log('All env vars:', Object.keys(process.env).filter(key => key.includes('API')));

import { runMigrations, db } from './db';
import { sql } from 'drizzle-orm';
import { initializeProviders } from './ai/providers';
import { MVPGenerator } from './ai/mvp-generator';
import { DocumentGenerator } from './ai/document-generator';
import { FileProcessor } from './utils/file-processor';
import { AuthService, authenticateToken, AuthenticatedRequest } from './auth';
import promptBuilderRoutes from './routes/prompt-builder';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize services
const aiFactory = initializeProviders();
const mvpGenerator = new MVPGenerator(aiFactory);
const documentGenerator = new DocumentGenerator(aiFactory);
const fileProcessor = new FileProcessor(process.env.UPLOAD_DIR);
const authService = new AuthService();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// File upload middleware
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE || '10485760'), // 10MB
  },
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    availableProviders: aiFactory.getAvailableProviders()
  });
});

// Root route - API documentation (development only)
if (process.env.NODE_ENV !== 'production') {
  app.get('/', (req, res) => {
    res.json({
      name: 'AID Kitty API',
      version: '1.0.0',
      description: 'AI-powered MVP generator with multi-LLM integration',
      endpoints: {
        health: 'GET /api/health',
        auth: {
          register: 'POST /api/auth/register',
          login: 'POST /api/auth/login',
          me: 'GET /api/auth/me'
        },
        projects: {
          list: 'GET /api/projects',
          create: 'POST /api/projects',
          plans: 'GET /api/projects/:id/plans'
        },
        files: {
          upload: 'POST /api/upload'
        },
        mvp: {
          generate: 'POST /api/generate-mvp',
          providers: 'GET /api/providers'
        },
        apiKeys: {
          list: 'GET /api/api-keys',
          create: 'POST /api/api-keys',
          delete: 'DELETE /api/api-keys/:id'
        },
        chat: {
          messages: 'GET /api/chat/messages',
          create: 'POST /api/chat/messages',
          clear: 'DELETE /api/chat/messages',
          templates: {
            list: 'GET /api/chat/templates',
            create: 'POST /api/chat/templates',
            update: 'PUT /api/chat/templates/:id',
            delete: 'DELETE /api/chat/templates/:id'
          }
        },
        documents: {
          generate: 'POST /api/generate-document',
          generateBatch: 'POST /api/generate-documents-batch',
          list: 'GET /api/projects/:projectId/documents'
        },
        estimationSettings: {
          list: 'GET /api/estimation-settings',
          create: 'POST /api/estimation-settings',
          update: 'PUT /api/estimation-settings/:id',
          delete: 'DELETE /api/estimation-settings/:id'
        }
      },
      availableProviders: aiFactory.getAvailableProviders(),
      timestamp: new Date().toISOString()
    });
  });
}

// Authentication routes
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }

    const user = await authService.register(username, email, password);
    res.status(201).json({ message: 'User created successfully', user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await authService.login(email, password);
    res.json(result);
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

app.get('/api/auth/me', authenticateToken, (req: AuthenticatedRequest, res) => {
  res.json({ user: req.user });
});

// Project routes
app.get('/api/projects', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { db } = await import('./db');
    const { projects } = await import('../shared/schema');
    const { eq } = await import('drizzle-orm');

    const userProjects = await db.select().from(projects).where(eq(projects.userId, req.user!.id));
    res.json(userProjects);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

app.post('/api/projects', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { title, description, requirements } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Project title is required' });
    }

    const { db } = await import('./db');
    const { projects, NewProject } = await import('../shared/schema');

    const newProject: NewProject = {
      userId: req.user!.id,
      title,
      description,
      requirements,
      status: 'draft',
    };

    const [project] = await db.insert(projects).values(newProject).returning();
    res.status(201).json(project);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create project' });
  }
});

// File upload route
app.post('/api/upload', authenticateToken, upload.single('file'), async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const validation = fileProcessor.validateFile(req.file);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const processedFile = await fileProcessor.processFile(req.file);

    // Save file info to database
    const { db } = await import('./db');
    const { fileUploads, NewFileUpload } = await import('../shared/schema');

    const newFileUpload: NewFileUpload = {
      projectId: req.body.projectId,
      filename: processedFile.filename,
      originalName: processedFile.originalName,
      mimeType: processedFile.mimeType,
      size: processedFile.size,
      extractedText: processedFile.extractedText,
      uploadPath: processedFile.uploadPath,
    };

    const [savedFile] = await db.insert(fileUploads).values(newFileUpload).returning();

    res.json({
      file: savedFile,
      extractedText: processedFile.extractedText,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// MVP generation routes
app.post('/api/generate-mvp', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { projectId, requirements, projectTitle, provider, planType } = req.body;

    if (!requirements || !projectTitle || !provider) {
      return res.status(400).json({
        error: 'Requirements, project title, and provider are required'
      });
    }

    const result = await mvpGenerator.generatePlan({
      requirements,
      projectTitle,
      provider,
      planType: planType || 'full_mvp',
    });

    // Save generated plan to database
    const { db } = await import('./db');
    const { generatedPlans, NewGeneratedPlan, projects } = await import('../shared/schema');
    const { eq } = await import('drizzle-orm');

    const newPlan: NewGeneratedPlan = {
      projectId,
      model: provider,
      planType: planType || 'full_mvp',
      content: result.content,
      tokensUsed: result.tokensUsed,
      generationTime: result.generationTime,
    };

    const [savedPlan] = await db.insert(generatedPlans).values(newPlan).returning();

    // Update project status
    await db.update(projects)
      .set({ status: 'completed', updatedAt: sql`now()` })
      .where(eq(projects.id, projectId));

    res.json({
      plan: savedPlan,
      result,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/projects/:id/plans', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;

    const { db } = await import('./db');
    const { generatedPlans, projects } = await import('../shared/schema');
    const { eq, and } = await import('drizzle-orm');

    // Verify project belongs to user
    const [project] = await db.select().from(projects)
      .where(and(eq(projects.id, id), eq(projects.userId, req.user!.id)))
      .limit(1);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const plans = await db.select().from(generatedPlans)
      .where(eq(generatedPlans.projectId, id));

    res.json(plans);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch plans' });
  }
});

// Available AI providers
app.get('/api/providers', (req, res) => {
  res.json({
    providers: aiFactory.getAvailableProviders(),
  });
});

// API Keys routes
app.get('/api/api-keys', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { db } = await import('./db');
    const { apiKeys } = await import('../shared/schema');
    const { eq } = await import('drizzle-orm');

    const userApiKeys = await db.select().from(apiKeys).where(eq(apiKeys.userId, req.user.id));
    res.json(userApiKeys);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/api-keys', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    console.log('📝 API Key creation request:', { body: req.body, userId: req.user.id });

    const { provider, name, key } = req.body;

    if (!provider || !key) {
      return res.status(400).json({ error: 'Provider and key are required' });
    }

    const { db } = await import('./db');
    const { apiKeys, NewApiKey } = await import('../shared/schema');

    const newApiKey: NewApiKey = {
      userId: req.user.id,
      provider,
      name: name || null,
      key,
      isActive: true,
    };

    console.log('💾 Attempting to save API key:', { ...newApiKey, key: '***hidden***' });

    const [savedApiKey] = await db.insert(apiKeys).values(newApiKey).returning();

    console.log('✅ API key saved successfully:', { id: savedApiKey.id, provider: savedApiKey.provider });
    res.json(savedApiKey);
  } catch (error) {
    console.error('❌ API Key creation error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/api-keys/:id', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const { db } = await import('./db');
    const { apiKeys } = await import('../shared/schema');
    const { eq, and } = await import('drizzle-orm');

    await db.delete(apiKeys).where(
      and(eq(apiKeys.id, id), eq(apiKeys.userId, req.user.id))
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Chat routes
app.get('/api/chat/messages', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { projectId } = req.query;
    const { db } = await import('./db');
    const { chatMessages } = await import('../shared/schema');
    const { eq, and, desc, isNull } = await import('drizzle-orm');

    const whereConditions = [eq(chatMessages.userId, req.user.id)];

    if (projectId) {
      whereConditions.push(eq(chatMessages.projectId, projectId as string));
    } else {
      whereConditions.push(isNull(chatMessages.projectId));
    }

    const messages = await db
      .select()
      .from(chatMessages)
      .where(whereConditions.length > 1 ? and(...whereConditions) : whereConditions[0])
      .orderBy(desc(chatMessages.createdAt));

    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/chat/messages', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { projectId } = req.query;
    const { db } = await import('./db');
    const { chatMessages } = await import('../shared/schema');
    const { eq, and, isNull } = await import('drizzle-orm');

    const whereConditions = [eq(chatMessages.userId, req.user.id)];

    if (projectId) {
      whereConditions.push(eq(chatMessages.projectId, projectId as string));
    } else {
      whereConditions.push(isNull(chatMessages.projectId));
    }

    await db
      .delete(chatMessages)
      .where(whereConditions.length > 1 ? and(...whereConditions) : whereConditions[0]);

    res.json({ success: true, message: 'Chat history cleared successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/chat/messages', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { content, provider, projectId } = req.body;

    if (!content || !provider) {
      return res.status(400).json({ error: 'Content and provider are required' });
    }

    const { db } = await import('./db');
    const { chatMessages, NewChatMessage } = await import('../shared/schema');
    const { eq, and, desc, isNull } = await import('drizzle-orm');
    const { ChatService } = await import('./ai/chat-service');

    // Save user message
    const userMessage: NewChatMessage = {
      userId: req.user.id,
      projectId: projectId || null,
      provider,
      role: 'user',
      content,
    };

    console.log(`💾 Attempting to save user message:`, userMessage);
    const [savedUserMessage] = await db.insert(chatMessages).values(userMessage).returning();
    console.log(`✅ User message saved:`, savedUserMessage);

    // Get recent conversation history for context
    const recentMessages = await db
      .select()
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.userId, req.user.id),
          projectId ? eq(chatMessages.projectId, projectId) : isNull(chatMessages.projectId)
        )
      )
      .orderBy(desc(chatMessages.createdAt))
      .limit(50);

    // Build conversation history (exclude the just-saved user message, then reverse for chronological order)
    const conversationHistory = recentMessages
      .slice(1) // Exclude the just-saved user message (first in desc order)
      .reverse() // Reverse to get chronological order
      .map(msg => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content
      }));

    // Debug logging
    console.log(`📝 Chat Debug - User: ${req.user.id}, Messages found: ${recentMessages.length}, History length: ${conversationHistory.length}`);
    console.log(`📝 Recent messages (raw):`, recentMessages.map(m => ({ id: m.id, role: m.role, content: m.content.substring(0, 50) + '...', createdAt: m.createdAt })));
    console.log(`📝 Conversation history (processed):`, conversationHistory.map(m => ({ role: m.role, content: m.content.substring(0, 50) + '...' })));
    if (conversationHistory.length > 0) {
      console.log(`📝 Last context message: ${conversationHistory[conversationHistory.length - 1]?.role} - ${conversationHistory[conversationHistory.length - 1]?.content?.substring(0, 100)}...`);
    }

    // Generate AI response using ChatService
    const chatService = new ChatService(aiFactory);
    const aiResponse = await chatService.generateResponse({
      message: content,
      provider,
      conversationHistory
    });

    // Save AI response
    const aiMessage: NewChatMessage = {
      userId: req.user.id,
      projectId: projectId || null,
      provider,
      role: 'assistant',
      content: aiResponse.content,
      metadata: JSON.stringify({
        tokensUsed: aiResponse.tokensUsed,
        generationTime: aiResponse.generationTime,
      }),
    };

    console.log(`💾 Attempting to save AI message:`, aiMessage);
    const [savedAiMessage] = await db.insert(chatMessages).values(aiMessage).returning();
    console.log(`✅ AI message saved:`, savedAiMessage);

    res.json({
      userMessage: savedUserMessage,
      aiMessage: savedAiMessage,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Chat Templates endpoints
app.get('/api/chat/templates', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { category } = req.query;

    const { db } = await import('./db');
    const { chatTemplates } = await import('../shared/schema');
    const { or, eq, and } = await import('drizzle-orm');

    let query = db
      .select()
      .from(chatTemplates)
      .where(
        or(
          eq(chatTemplates.userId, req.user.id),
          eq(chatTemplates.isPublic, true)
        )
      )
      .orderBy(chatTemplates.createdAt);

    if (category && typeof category === 'string') {
      query = query.where(eq(chatTemplates.category, category));
    }

    const templates = await query;
    res.json(templates);
  } catch (error) {
    console.error('Error fetching chat templates:', error);
    res.status(500).json({ error: 'Failed to fetch chat templates' });
  }
});

app.post('/api/chat/templates', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { name, description, content, category, tags, isPublic = false } = req.body;

    if (!name || !description || !content || !category) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { db } = await import('./db');
    const { chatTemplates, NewChatTemplate } = await import('../shared/schema');

    const newTemplate: NewChatTemplate = {
      userId: req.user.id,
      name,
      description,
      content,
      category,
      tags: JSON.stringify(tags || []),
      isPublic,
      usageCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const [template] = await db
      .insert(chatTemplates)
      .values(newTemplate)
      .returning();

    res.status(201).json(template);
  } catch (error) {
    console.error('Error creating chat template:', error);
    res.status(500).json({ error: 'Failed to create chat template' });
  }
});

app.put('/api/chat/templates/:id', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const templateId = req.params.id;
    const { name, description, content, category, tags, isPublic } = req.body;

    if (!name || !description || !content || !category) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { db } = await import('./db');
    const { chatTemplates } = await import('../shared/schema');
    const { eq, and } = await import('drizzle-orm');

    const [updatedTemplate] = await db
      .update(chatTemplates)
      .set({
        name,
        description,
        content,
        category,
        tags: JSON.stringify(tags || []),
        isPublic: isPublic || false,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(chatTemplates.id, templateId),
          eq(chatTemplates.userId, req.user.id)
        )
      )
      .returning();

    if (!updatedTemplate) {
      return res.status(404).json({ error: 'Template not found or not owned by user' });
    }

    res.json(updatedTemplate);
  } catch (error) {
    console.error('Error updating chat template:', error);
    res.status(500).json({ error: 'Failed to update chat template' });
  }
});

app.delete('/api/chat/templates/:id', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const templateId = req.params.id;

    const { db } = await import('./db');
    const { chatTemplates } = await import('../shared/schema');
    const { eq, and } = await import('drizzle-orm');

    const [deletedTemplate] = await db
      .delete(chatTemplates)
      .where(
        and(
          eq(chatTemplates.id, templateId),
          eq(chatTemplates.userId, req.user.id)
        )
      )
      .returning();

    if (!deletedTemplate) {
      return res.status(404).json({ error: 'Template not found or not owned by user' });
    }

    res.json({ message: 'Template deleted successfully' });
  } catch (error) {
    console.error('Error deleting chat template:', error);
    res.status(500).json({ error: 'Failed to delete chat template' });
  }
});

// Document generation route
app.post('/api/generate-document', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { projectId, requirements, projectTitle, provider, documentType } = req.body;

    if (!requirements || !projectTitle || !provider || !documentType) {
      return res.status(400).json({
        error: 'Requirements, project title, provider, and document type are required'
      });
    }

    const startTime = Date.now();
    const result = await documentGenerator.generateDocument({
      requirements,
      projectTitle,
      provider,
      documentType,
    });
    const generationTime = (Date.now() - startTime) / 1000;

    // Save generated document to database
    const { db } = await import('./db');
    const { generatedDocuments, NewGeneratedDocument, projects } = await import('../shared/schema');
    const { eq } = await import('drizzle-orm');

    const newDocument: NewGeneratedDocument = {
      projectId,
      model: provider,
      documentType,
      content: result.content,
      tokensUsed: 0, // Will be updated when we have token counting
      generationTime,
    };

    const [savedDocument] = await db.insert(generatedDocuments).values(newDocument).returning();

    // Update project status
    await db.update(projects)
      .set({ status: 'completed', updatedAt: sql`now()` })
      .where(eq(projects.id, projectId));

    res.json({
      document: savedDocument,
      result,
    });
  } catch (error) {
    console.error('Document generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Batch document generation route
app.post('/api/generate-documents-batch', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { projectId, requirements, projectTitle, provider, documentTypes } = req.body;

    if (!requirements || !projectTitle || !provider || !Array.isArray(documentTypes)) {
      return res.status(400).json({
        error: 'Requirements, project title, provider, and document types array are required'
      });
    }

    const startTime = Date.now();
    const documents = await documentGenerator.generateDocumentBatch(
      requirements,
      projectTitle,
      provider,
      documentTypes
    );
    const totalGenerationTime = (Date.now() - startTime) / 1000;

    // Save all generated documents to database
    const { db } = await import('./db');
    const { generatedDocuments, NewGeneratedDocument, projects } = await import('../shared/schema');
    const { eq } = await import('drizzle-orm');

    const savedDocuments = [];
    for (const doc of documents) {
      const newDocument: NewGeneratedDocument = {
        projectId,
        model: provider,
        documentType: doc.type,
        content: doc.content,
        tokensUsed: 0,
        generationTime: totalGenerationTime / documents.length, // Approximate per document
      };

      const [savedDocument] = await db.insert(generatedDocuments).values(newDocument).returning();
      savedDocuments.push(savedDocument);
    }

    // Update project status
    await db.update(projects)
      .set({ status: 'completed', updatedAt: sql`now()` })
      .where(eq(projects.id, projectId));

    res.json({
      documents: savedDocuments,
      generatedCount: documents.length,
      totalGenerationTime,
    });
  } catch (error) {
    console.error('Batch document generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get project documents route
app.get('/api/projects/:projectId/documents', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { projectId } = req.params;

    const { db } = await import('./db');
    const { generatedDocuments, projects } = await import('../shared/schema');
    const { eq, and } = await import('drizzle-orm');

    // Verify project belongs to user
    const project = await db.select().from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, req.user.id)))
      .limit(1);

    if (project.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Get all documents for the project
    const documents = await db.select().from(generatedDocuments)
      .where(eq(generatedDocuments.projectId, projectId))
      .orderBy(generatedDocuments.createdAt);

    res.json({ documents });
  } catch (error) {
    console.error('Get documents error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update document content
app.put('/api/documents/:id', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;

    if (!content) {
      return res.status(400).json({ error: 'Content is required' });
    }

    const { db } = await import('./db');
    const { generatedDocuments, projects } = await import('../shared/schema');
    const { eq, and } = await import('drizzle-orm');

    // First get the document to find its project
    const [document] = await db.select().from(generatedDocuments)
      .where(eq(generatedDocuments.id, id))
      .limit(1);

    if (!document) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Verify the project belongs to the user
    const [project] = await db.select().from(projects)
      .where(and(eq(projects.id, document.projectId), eq(projects.userId, req.user.id)))
      .limit(1);

    if (!project) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Update the document content
    const [updatedDocument] = await db.update(generatedDocuments)
      .set({ content })
      .where(eq(generatedDocuments.id, id))
      .returning();

    res.json({ document: updatedDocument });
  } catch (error) {
    console.error('Update document error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Estimation Settings endpoints
app.get('/api/estimation-settings', authenticateToken, async (req, res) => {
  try {
    const { db } = await import('./db');
    const { estimationSettings } = await import('../shared/schema');
    const { eq } = await import('drizzle-orm');

    const settings = await db.select()
      .from(estimationSettings)
      .where(eq(estimationSettings.userId, req.user.id))
      .orderBy(estimationSettings.createdAt);

    res.json({ settings });
  } catch (error) {
    console.error('Error fetching estimation settings:', error);
    res.status(500).json({ error: 'Failed to fetch estimation settings' });
  }
});

app.post('/api/estimation-settings', authenticateToken, async (req, res) => {
  try {
    const { name, description, complexityWeights, functionTypes, environmentalFactors, projectParameters, isDefault } = req.body;

    // If setting as default, unset other defaults
    if (isDefault) {
      const { db } = await import('./db');
      const { estimationSettings } = await import('../shared/schema');
      await db.update(estimationSettings)
        .set({ isDefault: false })
        .where(eq(estimationSettings.userId, req.user.id));
    }

    const { db } = await import('./db');
    const { estimationSettings, NewEstimationSetting } = await import('../shared/schema');

    const newSetting: NewEstimationSetting = {
      userId: req.user.id,
      name,
      description,
      complexityWeights,
      functionTypes,
      environmentalFactors,
      projectParameters,
      isDefault: isDefault || false
    };

    console.log('💾 Attempting to save estimation setting:', { ...newSetting, key: '***hidden***' });

    const [newSettingResult] = await db.insert(estimationSettings).values(newSetting).returning();

    console.log('✅ Estimation setting saved successfully:', { id: newSettingResult.id, name: newSettingResult.name });
    res.json({ setting: newSettingResult });
  } catch (error) {
    console.error('Error creating estimation setting:', error);
    res.status(500).json({ error: 'Failed to create estimation setting' });
  }
});

app.put('/api/estimation-settings/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, complexityWeights, functionTypes, environmentalFactors, projectParameters, isDefault } = req.body;

    // Verify ownership
    const { db } = await import('./db');
    const { estimationSettings } = await import('../shared/schema');
    const { eq, and } = await import('drizzle-orm');

    const existing = await db.select()
      .from(estimationSettings)
      .where(and(eq(estimationSettings.id, id), eq(estimationSettings.userId, req.user.id)))
      .limit(1);

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Estimation setting not found' });
    }

    // If setting as default, unset other defaults
    if (isDefault) {
      await db.update(estimationSettings)
        .set({ isDefault: false })
        .where(eq(estimationSettings.userId, req.user.id));
    }

    const updated = await db.update(estimationSettings)
      .set({
        name,
        description,
        complexityWeights,
        functionTypes,
        environmentalFactors,
        projectParameters,
        isDefault: isDefault || false,
        updatedAt: new Date()
      })
      .where(eq(estimationSettings.id, id))
      .returning();

    res.json({ setting: updated[0] });
  } catch (error) {
    console.error('Error updating estimation setting:', error);
    res.status(500).json({ error: 'Failed to update estimation setting' });
  }
});

app.delete('/api/estimation-settings/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Verify ownership
    const { db } = await import('./db');
    const { estimationSettings } = await import('../shared/schema');
    const { eq, and } = await import('drizzle-orm');

    const existing = await db.select()
      .from(estimationSettings)
      .where(and(eq(estimationSettings.id, id), eq(estimationSettings.userId, req.user.id)))
      .limit(1);

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Estimation setting not found' });
    }

    await db.delete(estimationSettings)
      .where(eq(estimationSettings.id, id));

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting estimation setting:', error);
    res.status(500).json({ error: 'Failed to delete estimation setting' });
  }
});

// GitHub Integration endpoints
import { GitHubService } from './github-service';

// Get GitHub settings
app.get('/api/github/settings', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { db } = await import('./db');
    const { githubSettings } = await import('../shared/schema');
    const { eq } = await import('drizzle-orm');

    const [settings] = await db.select({
      id: githubSettings.id,
      username: githubSettings.username,
      defaultRepo: githubSettings.defaultRepo,
      defaultBranch: githubSettings.defaultBranch,
      defaultPath: githubSettings.defaultPath,
      createdAt: githubSettings.createdAt,
    }).from(githubSettings)
      .where(eq(githubSettings.userId, req.user.id))
      .limit(1);

    res.json({ settings: settings || null, connected: !!settings });
  } catch (error) {
    console.error('Error getting GitHub settings:', error);
    res.status(500).json({ error: 'Failed to get GitHub settings' });
  }
});

// Connect GitHub (save PAT)
app.post('/api/github/connect', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { accessToken, defaultRepo, defaultBranch, defaultPath } = req.body;

    if (!accessToken) {
      return res.status(400).json({ error: 'Access token is required' });
    }

    // Validate the token
    const githubService = new GitHubService(accessToken);
    const validation = await githubService.validateToken();

    if (!validation.valid) {
      return res.status(400).json({ error: validation.error || 'Invalid GitHub token' });
    }

    const { db } = await import('./db');
    const { githubSettings } = await import('../shared/schema');
    const { eq } = await import('drizzle-orm');

    // Check if settings already exist
    const [existing] = await db.select().from(githubSettings)
      .where(eq(githubSettings.userId, req.user.id))
      .limit(1);

    if (existing) {
      // Update existing settings
      const [updated] = await db.update(githubSettings)
        .set({
          accessToken,
          username: validation.username,
          defaultRepo: defaultRepo || existing.defaultRepo,
          defaultBranch: defaultBranch || existing.defaultBranch,
          defaultPath: defaultPath || existing.defaultPath,
          updatedAt: new Date(),
        })
        .where(eq(githubSettings.userId, req.user.id))
        .returning();

      return res.json({ success: true, username: validation.username });
    }

    // Create new settings
    await db.insert(githubSettings).values({
      userId: req.user.id,
      accessToken,
      username: validation.username,
      defaultRepo,
      defaultBranch,
      defaultPath,
    });

    res.json({ success: true, username: validation.username });
  } catch (error) {
    console.error('Error connecting GitHub:', error);
    res.status(500).json({ error: 'Failed to connect GitHub' });
  }
});

// Disconnect GitHub
app.delete('/api/github/disconnect', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { db } = await import('./db');
    const { githubSettings } = await import('../shared/schema');
    const { eq } = await import('drizzle-orm');

    await db.delete(githubSettings)
      .where(eq(githubSettings.userId, req.user.id));

    res.json({ success: true });
  } catch (error) {
    console.error('Error disconnecting GitHub:', error);
    res.status(500).json({ error: 'Failed to disconnect GitHub' });
  }
});

// List GitHub repos
app.get('/api/github/repos', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { db } = await import('./db');
    const { githubSettings } = await import('../shared/schema');
    const { eq } = await import('drizzle-orm');

    const [settings] = await db.select().from(githubSettings)
      .where(eq(githubSettings.userId, req.user.id))
      .limit(1);

    if (!settings) {
      return res.status(400).json({ error: 'GitHub not connected' });
    }

    const githubService = new GitHubService(settings.accessToken);
    const repos = await githubService.listRepos();

    res.json({ repos });
  } catch (error) {
    console.error('Error listing repos:', error);
    res.status(500).json({ error: 'Failed to list repositories' });
  }
});

// List branches for a repo
app.get('/api/github/branches/:owner/:repo', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { owner, repo } = req.params;

    const { db } = await import('./db');
    const { githubSettings } = await import('../shared/schema');
    const { eq } = await import('drizzle-orm');

    const [settings] = await db.select().from(githubSettings)
      .where(eq(githubSettings.userId, req.user.id))
      .limit(1);

    if (!settings) {
      return res.status(400).json({ error: 'GitHub not connected' });
    }

    const githubService = new GitHubService(settings.accessToken);
    const branches = await githubService.listBranches(owner, repo);

    res.json({ branches });
  } catch (error) {
    console.error('Error listing branches:', error);
    res.status(500).json({ error: 'Failed to list branches' });
  }
});

// Push documents to GitHub
app.post('/api/github/push', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { projectId, repo, branch, path: folderPath, documentIds } = req.body;

    if (!repo) {
      return res.status(400).json({ error: 'Repository is required' });
    }

    const { db } = await import('./db');
    const { githubSettings, generatedDocuments, projects } = await import('../shared/schema');
    const { eq, and, inArray } = await import('drizzle-orm');

    // Get GitHub settings
    const [settings] = await db.select().from(githubSettings)
      .where(eq(githubSettings.userId, req.user.id))
      .limit(1);

    if (!settings) {
      return res.status(400).json({ error: 'GitHub not connected' });
    }

    // Get project details
    const [project] = await db.select().from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, req.user.id)))
      .limit(1);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Get documents to push
    let documents;
    if (documentIds && documentIds.length > 0) {
      documents = await db.select().from(generatedDocuments)
        .where(and(
          eq(generatedDocuments.projectId, projectId),
          inArray(generatedDocuments.id, documentIds)
        ));
    } else {
      documents = await db.select().from(generatedDocuments)
        .where(eq(generatedDocuments.projectId, projectId));
    }

    if (documents.length === 0) {
      return res.status(400).json({ error: 'No documents to push' });
    }

    // Parse repo (owner/repo format)
    const [owner, repoName] = repo.split('/');
    const targetBranch = branch || settings.defaultBranch || 'main';
    const targetPath = folderPath || settings.defaultPath || 'docs';

    const githubService = new GitHubService(settings.accessToken);

    // Push each document
    const results = [];
    for (const doc of documents) {
      const fileName = `${doc.documentType}.md`;
      const filePath = `${targetPath}/${project.title.replace(/[^a-zA-Z0-9-_]/g, '_')}/${fileName}`;

      const result = await githubService.pushFile(
        owner,
        repoName,
        filePath,
        doc.content,
        `Add ${doc.documentType} document for ${project.title}`,
        targetBranch
      );

      results.push({
        documentType: doc.documentType,
        path: filePath,
        ...result,
      });
    }

    const allSuccess = results.every(r => r.success);

    res.json({
      success: allSuccess,
      results,
      repo,
      branch: targetBranch,
      path: targetPath,
    });
  } catch (error) {
    console.error('Error pushing to GitHub:', error);
    res.status(500).json({ error: 'Failed to push to GitHub' });
  }
});

// Push selected prompt sessions to GitHub
app.post('/api/github/push-prompts', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { sessionIds, repo, branch, path: folderPath } = req.body;

    if (!repo || !sessionIds || sessionIds.length === 0) {
      return res.status(400).json({ error: 'Repository and sessionIds are required' });
    }

    const { db } = await import('./db');
    const { githubSettings, promptBuilderSessions, promptTemplates } = await import('../shared/schema');
    const { eq, and, inArray } = await import('drizzle-orm');

    // Get GitHub settings
    const [settings] = await db.select().from(githubSettings)
      .where(eq(githubSettings.userId, req.user.id))
      .limit(1);

    if (!settings) {
      return res.status(400).json({ error: 'GitHub not connected' });
    }

    // Get sessions with template info
    const sessionsData = await db
      .select({
        session: promptBuilderSessions,
        template: {
          name: promptTemplates.name,
          applicationType: promptTemplates.applicationType,
        }
      })
      .from(promptBuilderSessions)
      .leftJoin(promptTemplates, eq(promptBuilderSessions.templateId, promptTemplates.id))
      .where(and(
        eq(promptBuilderSessions.userId, req.user.id),
        inArray(promptBuilderSessions.id, sessionIds)
      ));

    if (sessionsData.length === 0) {
      return res.status(400).json({ error: 'No sessions found to push' });
    }

    // Parse repo
    const [owner, repoName] = repo.split('/');
    const targetBranch = branch || settings.defaultBranch || 'main';
    const targetPath = folderPath || settings.defaultPath || 'prompts';

    const githubService = new GitHubService(settings.accessToken);

    const results = [];
    for (const item of sessionsData) {
      const templateName = (item.template?.name || 'prompt').replace(/[^a-zA-Z0-9-_]/g, '_');
      const sessionDate = new Date(item.session.createdAt).toISOString().split('T')[0];
      const fileName = `${templateName}_${sessionDate}_${item.session.id.slice(0, 8)}.md`;
      const filePath = `${targetPath}/${fileName}`;

      const result = await githubService.pushFile(
        owner,
        repoName,
        filePath,
        item.session.generatedPrompt,
        `Add prompt: ${item.template?.name || 'generated'} (${sessionDate})`,
        targetBranch
      );

      results.push({
        sessionId: item.session.id,
        templateName: item.template?.name || 'Unknown',
        path: filePath,
        ...result,
      });
    }

    const allSuccess = results.every(r => r.success);

    res.json({
      success: allSuccess,
      results,
      repo,
      branch: targetBranch,
      path: targetPath,
    });
  } catch (error) {
    console.error('Error pushing prompts to GitHub:', error);
    res.status(500).json({ error: 'Failed to push prompts to GitHub' });
  }
});

// Push selected prompt templates to GitHub
app.post('/api/github/push-templates', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { templateIds, repo, branch, path: folderPath } = req.body;

    if (!repo || !templateIds || templateIds.length === 0) {
      return res.status(400).json({ error: 'Repository and templateIds are required' });
    }

    const { db } = await import('./db');
    const { githubSettings, promptTemplates } = await import('../shared/schema');
    const { eq, and, inArray } = await import('drizzle-orm');

    // Get GitHub settings
    const [settings] = await db.select().from(githubSettings)
      .where(eq(githubSettings.userId, req.user.id))
      .limit(1);

    if (!settings) {
      return res.status(400).json({ error: 'GitHub not connected' });
    }

    // Get templates
    const templates = await db
      .select()
      .from(promptTemplates)
      .where(and(
        eq(promptTemplates.userId, req.user.id),
        inArray(promptTemplates.id, templateIds)
      ));

    if (templates.length === 0) {
      return res.status(400).json({ error: 'No templates found to push' });
    }

    // Parse repo
    const [owner, repoName] = repo.split('/');
    const targetBranch = branch || settings.defaultBranch || 'main';
    const targetPath = folderPath || settings.defaultPath || 'templates';

    const githubService = new GitHubService(settings.accessToken);

    const results = [];
    for (const template of templates) {
      // Serialize template to markdown
      const content = `# ${template.name}\n\n${template.description || ''}\n\n**Application Type:** ${template.applicationType}\n**Category:** ${template.category}\n**Tags:** ${(template.tags as string[] || []).join(', ') || 'None'}\n\n## Architecture\n${typeof template.architecture === 'string' ? template.architecture : JSON.stringify(template.architecture, null, 2)}\n\n## Guidelines\n${JSON.stringify(template.guidelines, null, 2)}\n\n## Standards\n${JSON.stringify(template.standards, null, 2)}\n\n## Libraries\n${JSON.stringify(template.libraries, null, 2)}\n\n## Security\n${JSON.stringify(template.security, null, 2)}\n\n## Performance\n${JSON.stringify(template.performance, null, 2)}\n\n## Testing\n${JSON.stringify(template.testing, null, 2)}\n\n## Deployment\n${JSON.stringify(template.deployment, null, 2)}\n\n## Precautions\n${JSON.stringify(template.precautions, null, 2)}\n`;

      const safeName = template.name.replace(/[^a-zA-Z0-9-_]/g, '_');
      const fileName = `${safeName}.md`;
      const filePath = `${targetPath}/${fileName}`;

      const result = await githubService.pushFile(
        owner,
        repoName,
        filePath,
        content,
        `Add template: ${template.name}`,
        targetBranch
      );

      results.push({
        templateId: template.id,
        templateName: template.name,
        path: filePath,
        ...result,
      });
    }

    const allSuccess = results.every(r => r.success);

    res.json({
      success: allSuccess,
      results,
      repo,
      branch: targetBranch,
      path: targetPath,
    });
  } catch (error) {
    console.error('Error pushing templates to GitHub:', error);
    res.status(500).json({ error: 'Failed to push templates to GitHub' });
  }
});

// ==========================================
// OpenHands Cloud Integration endpoints
// ==========================================

// Get OpenHands settings
app.get('/api/openhands/settings', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { db } = await import('./db');
    const { openhandsSettings } = await import('../shared/schema');
    const { eq } = await import('drizzle-orm');

    const [settings] = await db.select({
      id: openhandsSettings.id,
      defaultRepo: openhandsSettings.defaultRepo,
      defaultBranch: openhandsSettings.defaultBranch,
      createdAt: openhandsSettings.createdAt,
    }).from(openhandsSettings)
      .where(eq(openhandsSettings.userId, req.user.id))
      .limit(1);

    res.json({ settings: settings || null, connected: !!settings });
  } catch (error) {
    console.error('Error getting OpenHands settings:', error);
    res.status(500).json({ error: 'Failed to get OpenHands settings' });
  }
});

// Save/update OpenHands settings
app.post('/api/openhands/settings', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { apiKey, defaultRepo, defaultBranch } = req.body;

    if (!apiKey) {
      return res.status(400).json({ error: 'API key is required' });
    }

    // Validate the API key
    const { OpenHandsService } = await import('./openhands');
    const service = new OpenHandsService(apiKey);
    const validation = await service.validateApiKey();

    if (!validation.valid) {
      return res.status(400).json({ error: validation.error || 'Invalid OpenHands API key' });
    }

    const { db } = await import('./db');
    const { openhandsSettings } = await import('../shared/schema');
    const { eq } = await import('drizzle-orm');

    // Check if settings already exist
    const [existing] = await db.select().from(openhandsSettings)
      .where(eq(openhandsSettings.userId, req.user.id))
      .limit(1);

    if (existing) {
      await db.update(openhandsSettings)
        .set({
          apiKey,
          defaultRepo: defaultRepo || existing.defaultRepo,
          defaultBranch: defaultBranch || existing.defaultBranch,
          updatedAt: new Date(),
        })
        .where(eq(openhandsSettings.userId, req.user.id));

      return res.json({ success: true, message: 'OpenHands settings updated' });
    }

    await db.insert(openhandsSettings).values({
      userId: req.user.id,
      apiKey,
      defaultRepo,
      defaultBranch,
    });

    res.json({ success: true, message: 'OpenHands connected' });
  } catch (error) {
    console.error('Error saving OpenHands settings:', error);
    res.status(500).json({ error: 'Failed to save OpenHands settings' });
  }
});

// Disconnect OpenHands
app.delete('/api/openhands/settings', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { db } = await import('./db');
    const { openhandsSettings } = await import('../shared/schema');
    const { eq } = await import('drizzle-orm');

    await db.delete(openhandsSettings)
      .where(eq(openhandsSettings.userId, req.user.id));

    res.json({ success: true });
  } catch (error) {
    console.error('Error disconnecting OpenHands:', error);
    res.status(500).json({ error: 'Failed to disconnect OpenHands' });
  }
});

// Start a build with OpenHands
app.post('/api/openhands/build', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { prompt, repository, sessionId } = req.body;

    if (!prompt || !repository) {
      return res.status(400).json({ error: 'Prompt and repository are required' });
    }

    const { db } = await import('./db');
    const { openhandsSettings, openhandsBuilds } = await import('../shared/schema');
    const { eq } = await import('drizzle-orm');

    // Get user's OpenHands settings
    const [settings] = await db.select().from(openhandsSettings)
      .where(eq(openhandsSettings.userId, req.user.id))
      .limit(1);

    if (!settings) {
      return res.status(400).json({ error: 'OpenHands not configured. Please add your API key in settings.' });
    }

    // Start conversation with OpenHands Cloud
    const { OpenHandsService } = await import('./openhands');
    const service = new OpenHandsService(settings.apiKey);
    const normalizedRepo = OpenHandsService.parseRepository(repository);
    console.log('[OpenHands Build] Repository normalized:', { input: repository, normalized: normalizedRepo });
    const conversation = await service.startConversation(prompt, normalizedRepo);

    const conversationUrl = OpenHandsService.getConversationUrl(conversation.conversation_id);

    // Save build record
    const [build] = await db.insert(openhandsBuilds).values({
      userId: req.user.id,
      sessionId: sessionId || null,
      conversationId: conversation.conversation_id,
      repository: normalizedRepo,
      prompt: prompt.substring(0, 5000), // Cap stored prompt length
      status: 'started',
      conversationUrl,
    }).returning();

    res.json({
      success: true,
      build: {
        id: build.id,
        conversationId: conversation.conversation_id,
        conversationUrl,
        status: 'started',
        repository: normalizedRepo,
      },
    });
  } catch (error: any) {
    console.error('Error starting OpenHands build:', error);
    res.status(500).json({ error: error.message || 'Failed to start OpenHands build' });
  }
});

// Get build status
app.get('/api/openhands/builds/:buildId/status', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { buildId } = req.params;

    const { db } = await import('./db');
    const { openhandsSettings, openhandsBuilds } = await import('../shared/schema');
    const { eq, and } = await import('drizzle-orm');

    // Get the build
    const [build] = await db.select().from(openhandsBuilds)
      .where(and(
        eq(openhandsBuilds.id, buildId),
        eq(openhandsBuilds.userId, req.user.id)
      ))
      .limit(1);

    if (!build) {
      return res.status(404).json({ error: 'Build not found' });
    }

    // Get settings for API key
    const [settings] = await db.select().from(openhandsSettings)
      .where(eq(openhandsSettings.userId, req.user.id))
      .limit(1);

    if (!settings) {
      return res.json({ build, liveStatus: null });
    }

    // Fetch live status from OpenHands
    try {
      const { OpenHandsService } = await import('./openhands');
      const service = new OpenHandsService(settings.apiKey);
      const liveStatus = await service.getConversationStatus(build.conversationId);

      console.log('[OpenHands Status Poll]', {
        buildId,
        conversationId: build.conversationId,
        storedStatus: build.status,
        liveStatusRaw: JSON.stringify(liveStatus),
      });

      // Map OpenHands status to our internal status
      // OpenHands statuses: RUNNING, STOPPED, ERROR, IDLE, PAUSED, FINISHED
      const ohStatus = (liveStatus.status || '').toUpperCase();
      let newStatus: string;

      // Stale detection: if status is RUNNING but last_updated_at hasn't changed
      // in more than 5 minutes, the agent has likely finished but never transitioned.
      let isStale = false;
      if (ohStatus === 'RUNNING' && liveStatus.last_updated_at) {
        const lastUpdate = new Date(liveStatus.last_updated_at).getTime();
        const now = Date.now();
        const staleThresholdMs = 5 * 60 * 1000; // 5 minutes
        isStale = (now - lastUpdate) > staleThresholdMs;
        if (isStale) {
          console.log('[OpenHands Stale Detection]', {
            buildId,
            lastUpdatedAt: liveStatus.last_updated_at,
            minutesStale: ((now - lastUpdate) / 60000).toFixed(1),
            runtimeStatus: liveStatus.runtime_status,
          });
        }
      }

      if (ohStatus === 'STOPPED' || ohStatus === 'FINISHED') {
        newStatus = 'completed';
      } else if (ohStatus === 'ERROR') {
        newStatus = 'failed';
      } else if (ohStatus === 'RUNNING' && isStale) {
        // Agent has been silent for 5+ minutes — treat as completed
        newStatus = 'completed';
      } else if (ohStatus === 'RUNNING') {
        newStatus = 'running';
      } else if (ohStatus === 'IDLE' || ohStatus === 'PAUSED') {
        // IDLE typically means the conversation is done (agent finished)
        newStatus = 'completed';
      } else {
        // Unknown status — keep stored
        newStatus = build.status;
      }

      console.log('[OpenHands Status Mapped]', { ohStatus, newStatus, previousStatus: build.status });

      if (newStatus !== build.status) {
        await db.update(openhandsBuilds)
          .set({ status: newStatus as any, updatedAt: new Date() })
          .where(eq(openhandsBuilds.id, buildId));
      }

      res.json({
        build: { ...build, status: newStatus },
        liveStatus,
      });
    } catch (statusError) {
      console.error('[OpenHands Status Error]', statusError);
      // Return stored status if live check fails
      res.json({ build, liveStatus: null });
    }
  } catch (error) {
    console.error('Error getting build status:', error);
    res.status(500).json({ error: 'Failed to get build status' });
  }
});

// List builds for user
app.get('/api/openhands/builds', authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const { db } = await import('./db');
    const { openhandsBuilds } = await import('../shared/schema');
    const { eq, desc } = await import('drizzle-orm');

    const builds = await db.select().from(openhandsBuilds)
      .where(eq(openhandsBuilds.userId, req.user.id))
      .orderBy(desc(openhandsBuilds.createdAt))
      .limit(50);

    res.json({ builds });
  } catch (error) {
    console.error('Error listing builds:', error);
    res.status(500).json({ error: 'Failed to list builds' });
  }
});

// Register routes
app.use('/api/prompt-builder', promptBuilderRoutes);

// Serve static files from the React app in production
if (process.env.NODE_ENV === 'production') {
  const clientDistPath = path.join(__dirname, '../client/dist');
  app.use(express.static(clientDistPath));

  // Catch all handler: send back React's index.html file for any non-API routes
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
}

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
async function startServer() {
  try {
    console.log('🚀 Starting AID Kitty server...');

    // Run database migrations
    await runMigrations();

    // Clean up old files on startup
    fileProcessor.cleanupOldFiles(24);

    // Schedule periodic cleanup
    setInterval(() => {
      fileProcessor.cleanupOldFiles(24);
    }, 60 * 60 * 1000); // Every hour

    app.listen(PORT, () => {
      console.log(`✅ AID Kitty server running on port ${PORT}`);
      console.log(`🤖 Available AI providers: ${aiFactory.getAvailableProviders().join(', ')}`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
