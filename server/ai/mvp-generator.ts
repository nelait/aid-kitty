import { AIProviderFactory, GenerationResult } from './providers';

export interface MVPGenerationRequest {
  requirements: string;
  projectTitle: string;
  projectDescription?: string;
  provider: string;
  planType: 'executive_summary' | 'technical_spec' | 'architecture' | 'implementation' | 'full_mvp';
}

export interface MVPPlan {
  executiveSummary: string;
  coreFeatures: string[];
  technicalStack: string;
  architecture: string;
  implementation: string;
  timeline: string;
  risks: string;
  successMetrics: string;
}

export class MVPGenerator {
  constructor(private aiFactory: AIProviderFactory) {}

  private getPromptTemplate(planType: string, requirements: string, title: string): string {
    const baseContext = `
Project Title: ${title}
Requirements: ${requirements}

You are an expert product strategist and technical architect. Generate a comprehensive, actionable response.
`;

    const prompts = {
      executive_summary: `${baseContext}
Create a concise executive summary (2-3 paragraphs) that includes:
- Problem statement and target market
- Core value proposition
- Key success factors
- High-level resource requirements`,

      technical_spec: `${baseContext}
Generate a detailed technical specification including:
- Recommended technology stack with rationale
- System architecture overview
- Database design considerations
- API structure and endpoints
- Security requirements
- Performance considerations
- Third-party integrations needed`,

      architecture: `${baseContext}
Design a comprehensive system architecture including:
- High-level system diagram description
- Component breakdown and responsibilities
- Data flow between components
- Scalability considerations
- Deployment architecture
- Infrastructure requirements
- Monitoring and logging strategy`,

      implementation: `${baseContext}
Create a detailed implementation plan including:
- Development phases with timelines
- Sprint breakdown (2-week sprints)
- Resource allocation and team structure
- Risk mitigation strategies
- Testing strategy
- Deployment plan
- Post-launch monitoring`,

      full_mvp: `${baseContext}
Generate a complete MVP implementation plan including:

## 1. Executive Summary
- Problem statement and market opportunity
- Solution overview and value proposition
- Target audience and user personas

## 2. Core Features (Prioritized)
- Must-have features for MVP
- Nice-to-have features for future versions
- User stories and acceptance criteria

## 3. Technical Architecture
- Recommended technology stack
- System architecture diagram description
- Database schema overview
- API design and endpoints

## 4. Implementation Roadmap
- Phase-by-phase development plan
- Sprint breakdown with deliverables
- Resource requirements and timeline
- Dependencies and critical path

## 5. Risk Assessment
- Technical risks and mitigation strategies
- Business risks and contingency plans
- Resource and timeline risks

## 6. Success Metrics
- Key Performance Indicators (KPIs)
- User engagement metrics
- Business metrics and goals
- Measurement and tracking plan

Format as structured markdown with clear sections and actionable items.`
    };

    return prompts[planType as keyof typeof prompts] || prompts.full_mvp;
  }

  async generatePlan(request: MVPGenerationRequest): Promise<GenerationResult> {
    const prompt = this.getPromptTemplate(
      request.planType,
      request.requirements,
      request.projectTitle
    );

    const options = {
      maxTokens: request.planType === 'full_mvp' ? 6000 : 4000,
      temperature: 0.7,
    };

    return await this.aiFactory.generateWithProvider(
      request.provider,
      prompt,
      options
    );
  }

  async generateMultiProviderComparison(
    request: Omit<MVPGenerationRequest, 'provider'>
  ): Promise<Record<string, GenerationResult>> {
    const availableProviders = this.aiFactory.getAvailableProviders();
    const results: Record<string, GenerationResult> = {};

    // Generate plans from all available providers
    const promises = availableProviders.map(async (provider) => {
      try {
        const result = await this.generatePlan({ ...request, provider });
        results[provider] = result;
      } catch (error) {
        console.error(`Error generating plan with ${provider}:`, error);
        results[provider] = {
          content: `Error: Failed to generate plan with ${provider}`,
          tokensUsed: 0,
          model: provider,
          generationTime: 0,
        };
      }
    });

    await Promise.all(promises);
    return results;
  }

  parseMVPPlan(content: string): Partial<MVPPlan> {
    const sections: Partial<MVPPlan> = {};

    // Extract executive summary
    const summaryMatch = content.match(/(?:## 1\. Executive Summary|# Executive Summary)([\s\S]*?)(?=##|#|$)/i);
    if (summaryMatch) {
      sections.executiveSummary = summaryMatch[1].trim();
    }

    // Extract core features
    const featuresMatch = content.match(/(?:## 2\. Core Features|# Core Features)([\s\S]*?)(?=##|#|$)/i);
    if (featuresMatch) {
      const featuresList = featuresMatch[1].match(/[-*]\s+(.+)/g);
      sections.coreFeatures = featuresList?.map(f => f.replace(/[-*]\s+/, '')) || [];
    }

    // Extract technical stack
    const techMatch = content.match(/(?:## 3\. Technical|# Technical)([\s\S]*?)(?=##|#|$)/i);
    if (techMatch) {
      sections.technicalStack = techMatch[1].trim();
    }

    // Extract architecture
    const archMatch = content.match(/(?:Architecture|System Design)([\s\S]*?)(?=##|#|$)/i);
    if (archMatch) {
      sections.architecture = archMatch[1].trim();
    }

    // Extract implementation
    const implMatch = content.match(/(?:## 4\. Implementation|# Implementation)([\s\S]*?)(?=##|#|$)/i);
    if (implMatch) {
      sections.implementation = implMatch[1].trim();
    }

    // Extract timeline
    const timelineMatch = content.match(/(?:Timeline|Roadmap|Schedule)([\s\S]*?)(?=##|#|$)/i);
    if (timelineMatch) {
      sections.timeline = timelineMatch[1].trim();
    }

    // Extract risks
    const riskMatch = content.match(/(?:## 5\. Risk|# Risk)([\s\S]*?)(?=##|#|$)/i);
    if (riskMatch) {
      sections.risks = riskMatch[1].trim();
    }

    // Extract success metrics
    const metricsMatch = content.match(/(?:## 6\. Success|# Success|# Metrics)([\s\S]*?)(?=##|#|$)/i);
    if (metricsMatch) {
      sections.successMetrics = metricsMatch[1].trim();
    }

    return sections;
  }
}
