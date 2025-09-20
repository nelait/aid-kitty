import { db } from './db';
import { promptTemplates, users, NewPromptTemplate } from '../shared/schema';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { createId } from '@paralleldrive/cuid2';

const seedTemplates: Omit<NewPromptTemplate, 'userId' | 'createdAt' | 'updatedAt'>[] = [
  {
    id: uuidv4(),
    name: 'React Web Application',
    description: 'Comprehensive template for building modern React web applications with TypeScript, routing, and state management',
    applicationType: 'web',
    category: 'frontend',
    tags: ['react', 'typescript', 'frontend', 'spa'],
    guidelines: {
      architecture: [
        'Use functional components with React Hooks',
        'Implement proper component composition and reusability',
        'Follow React best practices for state management',
        'Use TypeScript for type safety and better developer experience'
      ],
      structure: [
        'Organize components in a logical folder structure',
        'Separate business logic from UI components',
        'Use custom hooks for shared logic',
        'Implement proper error boundaries'
      ],
      performance: [
        'Implement code splitting and lazy loading',
        'Optimize bundle size and loading times',
        'Use React.memo and useMemo for performance optimization',
        'Implement proper caching strategies'
      ]
    },
    standards: {
      naming: [
        'Use PascalCase for component names',
        'Use camelCase for variables and functions',
        'Use kebab-case for file names',
        'Use descriptive and meaningful names'
      ],
      formatting: [
        'Use Prettier for code formatting',
        'Configure ESLint for code quality',
        'Use consistent indentation (2 spaces)',
        'Follow JSX formatting conventions'
      ],
      documentation: [
        'Document component props with TypeScript interfaces',
        'Add JSDoc comments for complex functions',
        'Maintain up-to-date README documentation',
        'Document API integrations and data flow'
      ]
    },
    libraries: {
      core: [
        'React 18+ with TypeScript',
        'React Router for navigation',
        'React Query or SWR for data fetching',
        'Zustand or Redux Toolkit for state management'
      ],
      ui: [
        'Tailwind CSS or Styled Components for styling',
        'Headless UI or Radix UI for accessible components',
        'React Hook Form for form handling',
        'Framer Motion for animations'
      ],
      utilities: [
        'Axios for HTTP requests',
        'Date-fns or Day.js for date manipulation',
        'Lodash for utility functions',
        'React Hot Toast for notifications'
      ]
    },
    architecture: {
      patterns: [
        'Component-based architecture',
        'Container/Presentational component pattern',
        'Custom hooks pattern',
        'Compound component pattern'
      ],
      dataFlow: [
        'Unidirectional data flow',
        'Props down, events up pattern',
        'Context for global state',
        'Server state vs client state separation'
      ],
      routing: [
        'File-based or declarative routing',
        'Protected routes for authentication',
        'Lazy loading for route components',
        'Proper error handling for routes'
      ]
    },
    security: {
      authentication: [
        'Implement secure authentication flow',
        'Use JWT tokens with proper expiration',
        'Store sensitive data securely',
        'Implement proper logout functionality'
      ],
      dataProtection: [
        'Validate and sanitize user inputs',
        'Implement CSRF protection',
        'Use HTTPS for all communications',
        'Avoid exposing sensitive data in client-side code'
      ],
      dependencies: [
        'Regularly update dependencies',
        'Use npm audit for security vulnerabilities',
        'Implement Content Security Policy',
        'Use environment variables for configuration'
      ]
    },
    performance: {
      optimization: [
        'Implement code splitting at route level',
        'Use React.lazy for component lazy loading',
        'Optimize images and assets',
        'Implement proper caching strategies'
      ],
      monitoring: [
        'Use React DevTools for debugging',
        'Implement error tracking (Sentry)',
        'Monitor bundle size and performance',
        'Use Lighthouse for performance audits'
      ],
      loading: [
        'Implement loading states for async operations',
        'Use skeleton screens for better UX',
        'Implement progressive loading',
        'Optimize initial page load time'
      ]
    },
    testing: {
      unit: [
        'Use Jest and React Testing Library',
        'Test component behavior, not implementation',
        'Mock external dependencies',
        'Achieve good test coverage'
      ],
      integration: [
        'Test user workflows and interactions',
        'Test API integrations',
        'Test routing and navigation',
        'Test form submissions and validations'
      ],
      e2e: [
        'Use Cypress or Playwright for E2E tests',
        'Test critical user journeys',
        'Test across different browsers',
        'Implement visual regression testing'
      ]
    },
    deployment: {
      build: [
        'Configure build optimization',
        'Implement environment-specific builds',
        'Use proper bundling strategies',
        'Optimize assets for production'
      ],
      hosting: [
        'Deploy to Vercel, Netlify, or AWS',
        'Configure proper redirects and rewrites',
        'Implement CDN for static assets',
        'Set up proper domain and SSL'
      ],
      cicd: [
        'Set up automated testing in CI/CD',
        'Implement automated deployments',
        'Use proper branching strategies',
        'Implement proper environment promotion'
      ]
    },
    precautions: {
      common_issues: [
        'Avoid prop drilling - use Context or state management',
        'Prevent memory leaks with proper cleanup',
        'Handle async operations properly',
        'Avoid mutating state directly'
      ],
      performance_pitfalls: [
        'Avoid unnecessary re-renders',
        'Be careful with useEffect dependencies',
        'Optimize expensive computations',
        'Avoid creating objects/functions in render'
      ],
      security_risks: [
        'Validate all user inputs',
        'Avoid XSS vulnerabilities',
        'Secure API endpoints',
        'Handle authentication properly'
      ]
    },
    customSections: []
  },
  {
    id: uuidv4(),
    name: 'Node.js REST API',
    description: 'Production-ready Node.js REST API with Express, TypeScript, authentication, and database integration',
    applicationType: 'api',
    category: 'backend',
    tags: ['nodejs', 'express', 'typescript', 'rest-api'],
    guidelines: {
      architecture: [
        'Use layered architecture (Controller, Service, Repository)',
        'Implement proper separation of concerns',
        'Use dependency injection where appropriate',
        'Follow RESTful API design principles'
      ],
      structure: [
        'Organize code by feature/domain',
        'Separate routes, controllers, services, and models',
        'Use middleware for cross-cutting concerns',
        'Implement proper error handling'
      ],
      performance: [
        'Implement proper caching strategies',
        'Use connection pooling for databases',
        'Optimize database queries',
        'Implement rate limiting and throttling'
      ]
    },
    standards: {
      naming: [
        'Use camelCase for variables and functions',
        'Use PascalCase for classes and interfaces',
        'Use kebab-case for file names',
        'Use descriptive and meaningful names'
      ],
      formatting: [
        'Use Prettier for code formatting',
        'Configure ESLint with TypeScript rules',
        'Use consistent indentation (2 spaces)',
        'Follow consistent import ordering'
      ],
      documentation: [
        'Use OpenAPI/Swagger for API documentation',
        'Document all endpoints with examples',
        'Maintain up-to-date README',
        'Document environment variables and setup'
      ]
    },
    libraries: {
      core: [
        'Node.js 18+ with TypeScript',
        'Express.js for web framework',
        'Helmet for security headers',
        'CORS for cross-origin requests'
      ],
      database: [
        'Prisma or TypeORM for database ORM',
        'PostgreSQL or MongoDB for database',
        'Redis for caching and sessions',
        'Database migration tools'
      ],
      utilities: [
        'Joi or Zod for validation',
        'Winston for logging',
        'Dotenv for environment variables',
        'Bcrypt for password hashing'
      ]
    },
    architecture: {
      patterns: [
        'MVC or Clean Architecture',
        'Repository pattern for data access',
        'Service layer for business logic',
        'Middleware pattern for request processing'
      ],
      dataFlow: [
        'Request → Middleware → Controller → Service → Repository',
        'Proper error propagation',
        'Response formatting and standardization',
        'Input validation and sanitization'
      ],
      authentication: [
        'JWT-based authentication',
        'Role-based access control',
        'Refresh token mechanism',
        'Secure session management'
      ]
    },
    security: {
      authentication: [
        'Implement secure password hashing',
        'Use JWT with proper expiration',
        'Implement refresh token rotation',
        'Add rate limiting for auth endpoints'
      ],
      dataProtection: [
        'Validate and sanitize all inputs',
        'Use parameterized queries',
        'Implement proper CORS policies',
        'Use HTTPS in production'
      ],
      dependencies: [
        'Regularly update dependencies',
        'Use npm audit for vulnerabilities',
        'Implement security headers',
        'Use environment variables for secrets'
      ]
    },
    performance: {
      optimization: [
        'Implement database indexing',
        'Use caching for frequently accessed data',
        'Optimize database queries',
        'Implement connection pooling'
      ],
      monitoring: [
        'Implement structured logging',
        'Use APM tools (New Relic, DataDog)',
        'Monitor API performance metrics',
        'Set up health check endpoints'
      ],
      scaling: [
        'Design for horizontal scaling',
        'Implement load balancing',
        'Use microservices where appropriate',
        'Implement proper error handling'
      ]
    },
    testing: {
      unit: [
        'Use Jest for unit testing',
        'Test business logic thoroughly',
        'Mock external dependencies',
        'Achieve good test coverage'
      ],
      integration: [
        'Test API endpoints with Supertest',
        'Test database operations',
        'Test authentication flows',
        'Test error handling scenarios'
      ],
      e2e: [
        'Test complete API workflows',
        'Test with real database',
        'Test performance under load',
        'Test security vulnerabilities'
      ]
    },
    deployment: {
      containerization: [
        'Use Docker for containerization',
        'Optimize Docker images for production',
        'Use multi-stage builds',
        'Implement proper health checks'
      ],
      hosting: [
        'Deploy to AWS, GCP, or Azure',
        'Use managed database services',
        'Implement proper monitoring',
        'Set up automated backups'
      ],
      cicd: [
        'Set up automated testing pipeline',
        'Implement automated deployments',
        'Use proper environment management',
        'Implement rollback strategies'
      ]
    },
    precautions: {
      common_issues: [
        'Handle async operations properly',
        'Implement proper error handling',
        'Avoid callback hell - use async/await',
        'Handle database connection issues'
      ],
      performance_pitfalls: [
        'Avoid N+1 query problems',
        'Implement proper caching',
        'Optimize database queries',
        'Handle memory leaks'
      ],
      security_risks: [
        'Validate all inputs',
        'Prevent SQL injection',
        'Implement proper authentication',
        'Secure sensitive endpoints'
      ]
    },
    customSections: []
  },
  {
    id: uuidv4(),
    name: 'RAG System with Vector Database',
    description: 'Retrieval-Augmented Generation system with vector embeddings, semantic search, and LLM integration',
    applicationType: 'rag',
    category: 'ai',
    tags: ['rag', 'vector-database', 'llm', 'embeddings', 'ai'],
    guidelines: {
      architecture: [
        'Implement proper document ingestion pipeline',
        'Use vector embeddings for semantic search',
        'Integrate with LLM for generation',
        'Implement proper retrieval strategies'
      ],
      structure: [
        'Separate ingestion, retrieval, and generation components',
        'Use proper data preprocessing pipelines',
        'Implement modular embedding strategies',
        'Design scalable vector storage'
      ],
      performance: [
        'Optimize vector similarity search',
        'Implement efficient chunking strategies',
        'Use proper caching for embeddings',
        'Optimize LLM inference'
      ]
    },
    standards: {
      naming: [
        'Use descriptive names for embedding models',
        'Follow consistent naming for vector collections',
        'Use clear naming for retrieval parameters',
        'Document model versions and configurations'
      ],
      formatting: [
        'Structure configuration files clearly',
        'Use consistent data formats',
        'Implement proper logging formats',
        'Follow API response standards'
      ],
      documentation: [
        'Document embedding model choices',
        'Explain chunking strategies',
        'Document retrieval parameters',
        'Maintain model performance metrics'
      ]
    },
    libraries: {
      vectordb: [
        'Pinecone, Weaviate, or Qdrant for vector storage',
        'FAISS for local vector search',
        'ChromaDB for development',
        'Elasticsearch with vector support'
      ],
      embeddings: [
        'OpenAI Embeddings API',
        'Sentence Transformers',
        'Cohere Embed API',
        'HuggingFace Transformers'
      ],
      llm: [
        'OpenAI GPT models',
        'Anthropic Claude',
        'Google PaLM API',
        'Local models with Ollama'
      ],
      processing: [
        'LangChain for orchestration',
        'Unstructured for document parsing',
        'PyPDF2 or pdfplumber for PDFs',
        'BeautifulSoup for web scraping'
      ]
    },
    architecture: {
      patterns: [
        'Pipeline architecture for data processing',
        'Microservices for different components',
        'Event-driven architecture for updates',
        'Plugin architecture for different data sources'
      ],
      dataFlow: [
        'Document → Chunking → Embedding → Vector Storage',
        'Query → Embedding → Similarity Search → Context Retrieval',
        'Context + Query → LLM → Generated Response',
        'Feedback loop for continuous improvement'
      ],
      retrieval: [
        'Semantic similarity search',
        'Hybrid search (semantic + keyword)',
        'Re-ranking strategies',
        'Context window optimization'
      ]
    },
    security: {
      dataProtection: [
        'Encrypt sensitive documents',
        'Implement access controls',
        'Audit data access patterns',
        'Secure API endpoints'
      ],
      privacy: [
        'Handle PII appropriately',
        'Implement data retention policies',
        'Provide data deletion capabilities',
        'Comply with privacy regulations'
      ],
      llmSecurity: [
        'Implement prompt injection protection',
        'Validate and sanitize inputs',
        'Monitor for harmful outputs',
        'Implement content filtering'
      ]
    },
    performance: {
      optimization: [
        'Optimize embedding generation',
        'Use efficient vector indexing',
        'Implement proper caching',
        'Batch processing for efficiency'
      ],
      scaling: [
        'Horizontal scaling for vector databases',
        'Load balancing for LLM requests',
        'Distributed processing pipelines',
        'Efficient data partitioning'
      ],
      monitoring: [
        'Track retrieval accuracy',
        'Monitor generation quality',
        'Measure response times',
        'Track resource utilization'
      ]
    },
    testing: {
      unit: [
        'Test embedding generation',
        'Test chunking strategies',
        'Test similarity calculations',
        'Test LLM integrations'
      ],
      integration: [
        'Test end-to-end RAG pipeline',
        'Test with different document types',
        'Test retrieval accuracy',
        'Test generation quality'
      ],
      evaluation: [
        'Implement retrieval evaluation metrics',
        'Use generation quality metrics',
        'A/B test different strategies',
        'Human evaluation of outputs'
      ]
    },
    deployment: {
      infrastructure: [
        'Deploy vector database clusters',
        'Set up LLM API integrations',
        'Implement processing pipelines',
        'Configure monitoring and logging'
      ],
      scaling: [
        'Auto-scaling for processing loads',
        'Load balancing for API requests',
        'Distributed vector storage',
        'Efficient resource management'
      ],
      monitoring: [
        'Track system performance',
        'Monitor data quality',
        'Alert on system failures',
        'Performance optimization'
      ]
    },
    precautions: {
      common_issues: [
        'Handle embedding model limitations',
        'Manage vector database performance',
        'Deal with LLM rate limits',
        'Handle document format variations'
      ],
      performance_pitfalls: [
        'Avoid inefficient chunking strategies',
        'Optimize vector search parameters',
        'Manage embedding costs',
        'Handle large document processing'
      ],
      quality_risks: [
        'Validate retrieval relevance',
        'Monitor generation hallucinations',
        'Handle context window limits',
        'Ensure response accuracy'
      ]
    },
    customSections: []
  }
];

async function seedPromptTemplates() {
  try {
    console.log('Starting to seed prompt templates...');
    
    // Create or get a system user for seeded templates
    let systemUserId = 'system-user-' + createId();
    
    // Check if any user exists, if not create a system user
    const existingUsers = await db.select().from(users).limit(1);
    
    if (existingUsers.length === 0) {
      // Create a system user
      await db.insert(users).values({
        id: systemUserId,
        username: 'system',
        email: 'system@aidkitty.local',
        passwordHash: 'system-hash', // Not used for system user
        createdAt: new Date(),
        updatedAt: new Date()
      });
      console.log('✓ Created system user for templates');
    } else {
      // Use the first existing user
      systemUserId = existingUsers[0].id;
      console.log('✓ Using existing user for templates');
    }
    
    for (const template of seedTemplates) {
      const templateData: NewPromptTemplate = {
        ...template,
        userId: systemUserId,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      
      // Check if template already exists
      const existing = await db
        .select()
        .from(promptTemplates)
        .where(eq(promptTemplates.name, template.name))
        .limit(1);
      
      if (existing.length === 0) {
        await db.insert(promptTemplates).values(templateData);
        console.log(`✓ Created template: ${template.name}`);
      } else {
        console.log(`- Template already exists: ${template.name}`);
      }
    }
    
    console.log('✓ Prompt templates seeding completed!');
  } catch (error) {
    console.error('Error seeding prompt templates:', error);
    throw error;
  }
}

// Run the seeding if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  seedPromptTemplates()
    .then(() => {
      console.log('Seeding completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Seeding failed:', error);
      process.exit(1);
    });
}

export { seedPromptTemplates };
