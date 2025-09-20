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

import { runMigrations } from './db';
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
      .set({ status: 'completed', updatedAt: new Date() })
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
      .set({ status: 'completed', updatedAt: new Date() })
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
      .set({ status: 'completed', updatedAt: new Date() })
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

// Register routes
app.use('/api/prompt-builder', promptBuilderRoutes);

// Serve static files from the React app in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client')));
  
  // Catch all handler: send back React's index.html file for any non-API routes
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/index.html'));
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

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`✅ AID Kitty server running on port ${PORT}`);
      console.log(`🤖 Available AI providers: ${aiFactory.getAvailableProviders().join(', ')}`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
