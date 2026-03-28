import { Router } from 'express';
import { db } from '../db';
import {
  promptTemplates,
  promptBuilderSessions,
  PromptTemplate,
  NewPromptTemplate,
  PromptBuilderSession,
  NewPromptBuilderSession
} from '../../shared/schema';
import { eq, desc, and, like, inArray } from 'drizzle-orm';
import { authenticateToken } from '../auth';
import { PromptBuilderService } from '../prompt-builder';

const router = Router();
const promptBuilderService = new PromptBuilderService();

// Get all prompt templates with optional filtering
router.get('/templates', authenticateToken, async (req, res) => {
  try {
    const {
      applicationType,
      category,
      search,
      tags,
      limit = 50,
      offset = 0
    } = req.query;

    let query = db.select().from(promptTemplates);
    const conditions = [];

    if (applicationType) {
      conditions.push(eq(promptTemplates.applicationType, applicationType as string));
    }

    if (category) {
      conditions.push(eq(promptTemplates.category, category as string));
    }

    if (search) {
      conditions.push(
        like(promptTemplates.name, `%${search}%`)
      );
    }

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const templates = await query
      .orderBy(desc(promptTemplates.createdAt))
      .limit(Number(limit))
      .offset(Number(offset));

    res.json({
      templates,
      pagination: {
        limit: Number(limit),
        offset: Number(offset),
        total: templates.length
      }
    });
  } catch (error) {
    console.error('Error fetching prompt templates:', error);
    res.status(500).json({ error: 'Failed to fetch prompt templates' });
  }
});

// Get a specific prompt template by ID
router.get('/templates/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const template = await db
      .select()
      .from(promptTemplates)
      .where(eq(promptTemplates.id, id))
      .limit(1);

    if (template.length === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }

    res.json(template[0]);
  } catch (error) {
    console.error('Error fetching prompt template:', error);
    res.status(500).json({ error: 'Failed to fetch prompt template' });
  }
});

// Create a new prompt template
router.post('/templates', authenticateToken, async (req, res) => {
  try {
    const templateData: NewPromptTemplate = {
      ...req.body,
      userId: req.user.id,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Validate required fields
    if (!templateData.name || !templateData.applicationType || !templateData.category) {
      return res.status(400).json({
        error: 'Missing required fields: name, applicationType, category'
      });
    }

    const [newTemplate] = await db
      .insert(promptTemplates)
      .values(templateData)
      .returning();

    res.status(201).json(newTemplate);
  } catch (error) {
    console.error('Error creating prompt template:', error);
    res.status(500).json({ error: 'Failed to create prompt template' });
  }
});

// Update an existing prompt template
router.put('/templates/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = {
      ...req.body,
      updatedAt: new Date()
    };

    // Check if template exists and belongs to user
    const existingTemplate = await db
      .select()
      .from(promptTemplates)
      .where(
        and(
          eq(promptTemplates.id, id),
          eq(promptTemplates.userId, req.user.id)
        )
      )
      .limit(1);

    if (existingTemplate.length === 0) {
      return res.status(404).json({ error: 'Template not found or access denied' });
    }

    const [updatedTemplate] = await db
      .update(promptTemplates)
      .set(updateData)
      .where(eq(promptTemplates.id, id))
      .returning();

    res.json(updatedTemplate);
  } catch (error) {
    console.error('Error updating prompt template:', error);
    res.status(500).json({ error: 'Failed to update prompt template' });
  }
});

// Delete a prompt template
router.delete('/templates/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if template exists and belongs to user
    const existingTemplate = await db
      .select()
      .from(promptTemplates)
      .where(
        and(
          eq(promptTemplates.id, id),
          eq(promptTemplates.userId, req.user.id)
        )
      )
      .limit(1);

    if (existingTemplate.length === 0) {
      return res.status(404).json({ error: 'Template not found or access denied' });
    }

    await db
      .delete(promptTemplates)
      .where(eq(promptTemplates.id, id));

    res.json({ message: 'Template deleted successfully' });
  } catch (error) {
    console.error('Error deleting prompt template:', error);
    res.status(500).json({ error: 'Failed to delete prompt template' });
  }
});

// Generate a prompt from a template
router.post('/generate', authenticateToken, async (req, res) => {
  try {
    const {
      templateId,
      projectDescription,
      selectedFeatures = [],
      customRequirements = [],
      projectId,
      selectedDocumentIds,
      docsPath
    } = req.body;

    if (!templateId || !projectDescription) {
      return res.status(400).json({
        error: 'Missing required fields: templateId, projectDescription'
      });
    }

    // Get the template
    const template = await db
      .select()
      .from(promptTemplates)
      .where(eq(promptTemplates.id, templateId))
      .limit(1);

    if (template.length === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }

    // Fetch attached documents if a project is selected
    let attachedDocuments: { documentType: string; content: string }[] = [];
    if (projectId) {
      const { generatedDocuments } = await import('../../shared/schema');
      const allDocs = await db
        .select({
          id: generatedDocuments.id,
          documentType: generatedDocuments.documentType,
          content: generatedDocuments.content,
        })
        .from(generatedDocuments)
        .where(eq(generatedDocuments.projectId, projectId));

      // Filter by selected IDs if provided, otherwise include all
      if (selectedDocumentIds && selectedDocumentIds.length > 0) {
        attachedDocuments = allDocs.filter(d => selectedDocumentIds.includes(d.id));
      } else {
        attachedDocuments = allDocs;
      }
    }

    // Generate the prompt
    const generatedPrompt = promptBuilderService.generatePrompt(
      template[0],
      projectDescription,
      selectedFeatures,
      customRequirements,
      attachedDocuments.length > 0 ? attachedDocuments : undefined,
      docsPath
    );

    // Save the session
    const sessionData: NewPromptBuilderSession = {
      userId: req.user.id,
      templateId,
      projectDescription,
      selectedFeatures,
      customRequirements,
      generatedPrompt,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const [session] = await db
      .insert(promptBuilderSessions)
      .values(sessionData)
      .returning();

    res.json({
      session,
      prompt: generatedPrompt
    });
  } catch (error) {
    console.error('Error generating prompt:', error);
    res.status(500).json({ error: 'Failed to generate prompt' });
  }
});

// Get user's prompt generation sessions
router.get('/sessions', authenticateToken, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;

    const sessionsData = await db
      .select({
        session: promptBuilderSessions,
        template: {
          id: promptTemplates.id,
          name: promptTemplates.name,
          applicationType: promptTemplates.applicationType,
          category: promptTemplates.category
        }
      })
      .from(promptBuilderSessions)
      .leftJoin(promptTemplates, eq(promptBuilderSessions.templateId, promptTemplates.id))
      .where(eq(promptBuilderSessions.userId, req.user.id))
      .orderBy(desc(promptBuilderSessions.createdAt))
      .limit(Number(limit))
      .offset(Number(offset));

    // Flatten the structure to match frontend expectations
    const sessions = sessionsData.map(item => ({
      ...item.session,
      template: item.template
    }));

    res.json({
      sessions,
      pagination: {
        limit: Number(limit),
        offset: Number(offset),
        total: sessions.length
      }
    });
  } catch (error) {
    console.error('Error fetching prompt sessions:', error);
    res.status(500).json({ error: 'Failed to fetch prompt sessions' });
  }
});

// Get a specific prompt session
router.get('/sessions/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const session = await db
      .select({
        session: promptBuilderSessions,
        template: promptTemplates
      })
      .from(promptBuilderSessions)
      .leftJoin(promptTemplates, eq(promptBuilderSessions.templateId, promptTemplates.id))
      .where(
        and(
          eq(promptBuilderSessions.id, id),
          eq(promptBuilderSessions.userId, req.user.id)
        )
      )
      .limit(1);

    if (session.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json(session[0]);
  } catch (error) {
    console.error('Error fetching prompt session:', error);
    res.status(500).json({ error: 'Failed to fetch prompt session' });
  }
});

// Update a prompt session's generated prompt
router.put('/sessions/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { generatedPrompt } = req.body;

    if (!generatedPrompt) {
      return res.status(400).json({ error: 'generatedPrompt is required' });
    }

    // Check if session exists and belongs to user
    const existingSession = await db
      .select()
      .from(promptBuilderSessions)
      .where(
        and(
          eq(promptBuilderSessions.id, id),
          eq(promptBuilderSessions.userId, req.user.id)
        )
      )
      .limit(1);

    if (existingSession.length === 0) {
      return res.status(404).json({ error: 'Session not found or access denied' });
    }

    const [updatedSession] = await db
      .update(promptBuilderSessions)
      .set({ generatedPrompt, updatedAt: new Date() })
      .where(eq(promptBuilderSessions.id, id))
      .returning();

    res.json(updatedSession);
  } catch (error) {
    console.error('Error updating prompt session:', error);
    res.status(500).json({ error: 'Failed to update prompt session' });
  }
});

// Delete a prompt session
router.delete('/sessions/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if session exists and belongs to user
    const existingSession = await db
      .select()
      .from(promptBuilderSessions)
      .where(
        and(
          eq(promptBuilderSessions.id, id),
          eq(promptBuilderSessions.userId, req.user.id)
        )
      )
      .limit(1);

    if (existingSession.length === 0) {
      return res.status(404).json({ error: 'Session not found or access denied' });
    }

    await db
      .delete(promptBuilderSessions)
      .where(eq(promptBuilderSessions.id, id));

    res.json({ message: 'Session deleted successfully' });
  } catch (error) {
    console.error('Error deleting prompt session:', error);
    res.status(500).json({ error: 'Failed to delete prompt session' });
  }
});

// Get available application types and categories
router.get('/metadata', authenticateToken, async (req, res) => {
  try {
    const applicationTypes = [
      'web', 'mobile', 'rag', 'api', 'desktop', 'ml', 'blockchain',
      'iot', 'game', 'cli', 'microservice', 'chrome-extension', 'electron', 'pwa'
    ];

    const categories = [
      'frontend', 'backend', 'fullstack', 'ai', 'data',
      'devops', 'security', 'testing', 'infrastructure'
    ];

    const priorities = ['low', 'medium', 'high', 'critical'];
    const impacts = ['low', 'medium', 'high'];
    const severities = ['low', 'medium', 'high', 'critical'];

    res.json({
      applicationTypes,
      categories,
      priorities,
      impacts,
      severities
    });
  } catch (error) {
    console.error('Error fetching metadata:', error);
    res.status(500).json({ error: 'Failed to fetch metadata' });
  }
});

// Duplicate a template
router.post('/templates/:id/duplicate', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    // Get the original template
    const originalTemplate = await db
      .select()
      .from(promptTemplates)
      .where(eq(promptTemplates.id, id))
      .limit(1);

    if (originalTemplate.length === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }

    // Create a duplicate
    const duplicateData: NewPromptTemplate = {
      ...originalTemplate[0],
      id: undefined, // Let the database generate a new ID
      name: name || `${originalTemplate[0].name} (Copy)`,
      userId: req.user.id,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const [newTemplate] = await db
      .insert(promptTemplates)
      .values(duplicateData)
      .returning();

    res.status(201).json(newTemplate);
  } catch (error) {
    console.error('Error duplicating template:', error);
    res.status(500).json({ error: 'Failed to duplicate template' });
  }
});

export default router;
