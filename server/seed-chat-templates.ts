import dotenv from 'dotenv';
dotenv.config();

import { db } from './db';
import { chatTemplates } from '../shared/schema';
import { v4 as uuidv4 } from 'uuid';

interface ChatTemplate {
  id: string;
  userId: string;
  name: string;
  description: string;
  content: string;
  category: string;
  tags: string;
  isPublic: boolean;
  usageCount: number;
  createdAt: number;
  updatedAt: number;
}

const seedTemplates: Omit<ChatTemplate, 'userId'>[] = [
  {
    id: uuidv4(),
    name: 'MVP Idea Validation',
    description: 'Validate your MVP idea and get comprehensive feedback on viability, market fit, and implementation strategy',
    content: `I have an MVP idea: [describe your idea in detail]. Can you help me:

1. **Problem Analysis**: Identify the core problem it solves and validate if it's a real pain point
2. **Target Audience**: Analyze who would benefit most from this solution
3. **Minimum Features**: Suggest the absolute minimum features needed for the first version
4. **Market Validation**: Recommend strategies to validate market demand before building
5. **Potential Challenges**: Identify technical, business, and market challenges
6. **Success Metrics**: Suggest KPIs to measure if the MVP is successful`,
    category: 'mvp-planning',
    tags: JSON.stringify(['validation', 'planning', 'strategy', 'market-fit']),
    isPublic: true,
    usageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: uuidv4(),
    name: 'Tech Stack Recommendation',
    description: 'Get personalized tech stack recommendations based on your MVP requirements, team skills, and constraints',
    content: `I'm building an MVP for [describe your product/service]. Here are my requirements:

**Product Details:**
- Core functionality: [describe main features]
- Target platform: [web/mobile/desktop/all]
- Expected user load: [small (<1K users)/medium (1K-10K)/large (>10K)]

**Team & Resources:**
- Team size: [number of developers]
- Team expertise: [list technologies and frameworks team knows]
- Budget constraints: [any budget limitations]
- Timeline: [expected launch timeframe]

**Technical Requirements:**
- Real-time features needed: [yes/no, describe]
- Data sensitivity: [public/private/regulated]
- Integration needs: [third-party services to integrate]

Please recommend:
1. Frontend framework and why
2. Backend framework and language
3. Database solution
4. Hosting/deployment platform
5. Key libraries and tools
6. Estimated development timeline`,
    category: 'technical',
    tags: JSON.stringify(['technology', 'architecture', 'stack', 'infrastructure']),
    isPublic: true,
    usageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: uuidv4(),
    name: 'Feature Prioritization',
    description: 'Prioritize your feature list using proven frameworks to focus on what matters most for your MVP',
    content: `I have these features in mind for my MVP:

**Feature List:**
1. [Feature 1 - brief description]
2. [Feature 2 - brief description]
3. [Feature 3 - brief description]
[add more as needed]

**Context:**
- Target launch date: [timeframe]
- Main user pain point: [describe]
- Primary business goal: [describe]

Please help me prioritize using the MoSCoW method:

**Must-have** (Critical for MVP launch):
- [Features that are absolutely essential]

**Should-have** (Important but not critical):
- [Features that add significant value]

**Could-have** (Nice to have):
- [Features for future iterations]

**Won't-have** (Not for MVP):
- [Features to explicitly exclude]

For each category, explain:
- Why it belongs there
- User value vs development effort
- Impact on time to market
- Dependencies between features`,
    category: 'mvp-planning',
    tags: JSON.stringify(['features', 'prioritization', 'planning', 'moscow']),
    isPublic: true,
    usageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: uuidv4(),
    name: 'User Story Generator',
    description: 'Generate detailed user stories with acceptance criteria and edge cases for your features',
    content: `I need user stories for this feature:

**Feature:** [describe the feature in detail]
**User Type:** [who will use it - e.g., end user, admin, guest]
**Primary Goal:** [what they want to achieve]
**Context:** [when/why they would use this feature]

Please generate:

1. **Main User Story** in format:
   "As a [user type], I want to [action] so that [benefit]"

2. **Acceptance Criteria:**
   - Given [precondition]
   - When [action]
   - Then [expected result]

3. **Edge Cases to Consider:**
   - [List potential edge cases]

4. **Non-functional Requirements:**
   - Performance expectations
   - Security considerations
   - Accessibility needs

5. **Related User Stories:**
   - [Any dependent or related stories]`,
    category: 'development',
    tags: JSON.stringify(['user-stories', 'requirements', 'agile', 'acceptance-criteria']),
    isPublic: true,
    usageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: uuidv4(),
    name: 'API Design Helper',
    description: 'Design RESTful API endpoints with proper structure, methods, and error handling',
    content: `I need to design an API for: [feature/resource name]

**Resource Description:**
[Describe what this resource represents]

**Operations Needed:**
- Create: [describe what data is needed]
- Read: [list/detail views needed]
- Update: [what fields can be updated]
- Delete: [soft/hard delete, conditions]
- Other: [any custom operations]

**Requirements:**
- Authentication: [required/optional/none]
- Authorization: [role-based/owner-only/public]
- Pagination: [needed for list views?]
- Filtering/Search: [what fields to filter by]

Please help me design:

1. **Endpoint Structure:**
   - Base URL and versioning
   - Resource naming conventions
   - Nested resources (if any)

2. **HTTP Methods & Endpoints:**
   - GET, POST, PUT, PATCH, DELETE
   - Query parameters
   - Path parameters

3. **Request/Response Formats:**
   - Request body schemas
   - Response body schemas
   - Headers needed

4. **Status Codes:**
   - Success scenarios
   - Error scenarios
   - Edge cases

5. **Error Handling:**
   - Error response format
   - Common error codes
   - Validation errors

6. **Best Practices:**
   - Rate limiting
   - Caching strategy
   - Documentation approach`,
    category: 'technical',
    tags: JSON.stringify(['api', 'design', 'backend', 'rest', 'endpoints']),
    isPublic: true,
    usageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: uuidv4(),
    name: 'Database Schema Design',
    description: 'Design optimized database schemas with proper relationships, indexes, and constraints',
    content: `I need to design a database schema for: [feature/domain name]

**Domain Description:**
[Describe the business domain]

**Entities Involved:**
1. [Entity 1] - [brief description]
2. [Entity 2] - [brief description]
3. [Entity 3] - [brief description]

**Relationships:**
- [Entity A] to [Entity B]: [one-to-one/one-to-many/many-to-many]
- [Describe the relationship and why]

**Key Operations:**
- [List common queries/operations]
- [Expected data volume]
- [Performance requirements]

Please help me design:

1. **Table Structures:**
   - Table names (following conventions)
   - Column names and types
   - Primary keys
   - Foreign keys

2. **Relationships:**
   - Foreign key constraints
   - Junction tables (for many-to-many)
   - Cascade rules

3. **Indexes:**
   - Which columns to index
   - Composite indexes
   - Unique constraints

4. **Data Integrity:**
   - NOT NULL constraints
   - CHECK constraints
   - Default values
   - Validation rules

5. **Performance Considerations:**
   - Denormalization opportunities
   - Partitioning strategy
   - Archive strategy

6. **Migration Strategy:**
   - Initial schema
   - Future extensibility`,
    category: 'technical',
    tags: JSON.stringify(['database', 'schema', 'design', 'sql', 'data-modeling']),
    isPublic: true,
    usageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: uuidv4(),
    name: 'Code Review Request',
    description: 'Get comprehensive code review feedback on quality, performance, security, and best practices',
    content: `Please review this code:

**Language/Framework:** [e.g., TypeScript/React, Python/Django]

**Code:**
\`\`\`[language]
[paste your code here]
\`\`\`

**Context:**
- Purpose: [what this code does]
- Part of: [which feature/module]
- Concerns: [any specific areas you're unsure about]

Please provide feedback on:

1. **Code Quality:**
   - Readability and clarity
   - Naming conventions
   - Code organization
   - DRY principle adherence

2. **Best Practices:**
   - Language/framework-specific patterns
   - Design patterns usage
   - SOLID principles
   - Error handling

3. **Potential Issues:**
   - Bugs or logic errors
   - Edge cases not handled
   - Race conditions
   - Memory leaks

4. **Performance:**
   - Algorithmic complexity
   - Unnecessary operations
   - Optimization opportunities
   - Caching possibilities

5. **Security:**
   - Input validation
   - SQL injection risks
   - XSS vulnerabilities
   - Authentication/authorization

6. **Testing:**
   - Testability of the code
   - Suggested test cases
   - Mocking requirements

7. **Refactoring Suggestions:**
   - How to improve structure
   - Alternative approaches
   - Simplification opportunities`,
    category: 'development',
    tags: JSON.stringify(['code-review', 'quality', 'best-practices', 'refactoring']),
    isPublic: true,
    usageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: uuidv4(),
    name: 'Bug Debugging Assistant',
    description: 'Get systematic help debugging issues with root cause analysis and solution suggestions',
    content: `I'm experiencing this bug and need help debugging:

**Bug Description:**
[Describe the issue in detail]

**Expected Behavior:**
[What should happen]

**Actual Behavior:**
[What is actually happening]

**Error Messages:**
\`\`\`
[Paste any error messages, stack traces, or console logs]
\`\`\`

**Environment:**
- OS: [operating system]
- Browser/Runtime: [if applicable]
- Framework versions: [list relevant versions]

**Code Snippet:**
\`\`\`[language]
[Paste the relevant code where the issue occurs]
\`\`\`

**Steps to Reproduce:**
1. [Step 1]
2. [Step 2]
3. [Step 3]

**What I've Tried:**
- [List debugging steps you've already attempted]

**Additional Context:**
- When did this start happening?
- Does it happen consistently or intermittently?
- Any recent changes that might be related?

Please help me:

1. **Root Cause Analysis:**
   - Identify the likely cause
   - Explain why it's happening

2. **Solution:**
   - Provide a fix with code examples
   - Explain why this fix works

3. **Prevention:**
   - How to prevent similar issues
   - Best practices to follow

4. **Testing:**
   - How to verify the fix
   - Test cases to add`,
    category: 'development',
    tags: JSON.stringify(['debugging', 'troubleshooting', 'bugs', 'errors']),
    isPublic: true,
    usageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: uuidv4(),
    name: 'Security Audit Request',
    description: 'Get security recommendations and identify potential vulnerabilities in your application',
    content: `I need a security audit for my application:

**Application Type:**
[Web app/Mobile app/API/etc.]

**Tech Stack:**
- Frontend: [framework/libraries]
- Backend: [framework/language]
- Database: [type]
- Authentication: [method used]

**Current Security Measures:**
- [List what you've already implemented]

**Areas of Concern:**
[Describe any specific security concerns]

**Code/Architecture:**
\`\`\`
[Paste relevant code or describe architecture]
\`\`\`

Please audit for:

1. **Authentication & Authorization:**
   - Login security
   - Session management
   - Token handling
   - Role-based access control

2. **Data Protection:**
   - Encryption at rest
   - Encryption in transit
   - Sensitive data handling
   - PII protection

3. **Input Validation:**
   - SQL injection risks
   - XSS vulnerabilities
   - CSRF protection
   - File upload security

4. **API Security:**
   - Rate limiting
   - API key management
   - CORS configuration
   - Request validation

5. **Infrastructure:**
   - Environment variables
   - Secrets management
   - Dependency vulnerabilities
   - Server configuration

6. **Compliance:**
   - GDPR considerations
   - Data retention policies
   - Audit logging

Provide:
- Risk level for each issue (Critical/High/Medium/Low)
- Specific remediation steps
- Code examples for fixes`,
    category: 'technical',
    tags: JSON.stringify(['security', 'audit', 'vulnerabilities', 'best-practices']),
    isPublic: true,
    usageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: uuidv4(),
    name: 'Performance Optimization',
    description: 'Analyze and optimize application performance with specific recommendations',
    content: `I need help optimizing performance for:

**Application Type:**
[Web/Mobile/Backend API]

**Current Performance Issues:**
- [Describe what's slow]
- [Metrics: load time, response time, etc.]

**Code/Component:**
\`\`\`[language]
[Paste the code that needs optimization]
\`\`\`

**Context:**
- User load: [concurrent users]
- Data volume: [amount of data being processed]
- Current infrastructure: [hosting, resources]

**Profiling Data:**
[If available, paste profiling results, slow query logs, etc.]

Please analyze and provide:

1. **Performance Bottlenecks:**
   - Identify slow operations
   - Database query issues
   - Network latency problems
   - Memory usage concerns

2. **Frontend Optimization:**
   - Bundle size reduction
   - Code splitting opportunities
   - Lazy loading strategies
   - Caching strategies
   - Image optimization

3. **Backend Optimization:**
   - Query optimization
   - Caching layers (Redis, etc.)
   - Connection pooling
   - Async operations
   - Background jobs

4. **Database Optimization:**
   - Index recommendations
   - Query rewrites
   - Denormalization opportunities
   - Partitioning strategies

5. **Infrastructure:**
   - CDN usage
   - Load balancing
   - Horizontal scaling
   - Resource allocation

6. **Monitoring:**
   - Key metrics to track
   - Alerting thresholds
   - Performance testing strategy

Provide:
- Specific code changes
- Expected performance improvements
- Implementation priority`,
    category: 'technical',
    tags: JSON.stringify(['performance', 'optimization', 'scaling', 'profiling']),
    isPublic: true,
    usageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

async function seedChatTemplates() {
  try {
    console.log('🌱 Starting chat templates seeding...');

    // Get the first user to assign templates to
    const users = await db.query.users.findMany({ limit: 1 });
    
    if (users.length === 0) {
      console.error('❌ No users found. Please create a user first.');
      process.exit(1);
    }

    const userId = users[0].id;
    console.log(`📝 Assigning templates to user: ${users[0].username} (${userId})`);

    // Insert templates
    for (const template of seedTemplates) {
      await db.insert(chatTemplates).values({
        ...template,
        userId,
      });
      console.log(`✅ Created template: ${template.name}`);
    }

    console.log(`\n🎉 Successfully seeded ${seedTemplates.length} chat templates!`);
    console.log('💡 Refresh your Chat page to see the templates in the dropdown.');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding chat templates:', error);
    process.exit(1);
  }
}

// Run the seed function
seedChatTemplates();
