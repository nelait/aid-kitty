import { v4 as uuidv4 } from 'uuid';
import {
  PromptTemplate,
  NewPromptTemplate,
  PromptBuilderSession,
  NewPromptBuilderSession,
  ApplicationType,
  ApplicationCategory,
  GuidelineItem,
  StandardItem,
  LibraryItem,
  PrecautionItem,
  BestPracticeItem,
  ArchitectureGuidelines,
  SecurityItem,
  PerformanceItem,
  TestingItem,
  DeploymentItem,
  CustomSection
} from '../shared/schema';

export class PromptBuilderService {

  /**
   * Generate a comprehensive coding prompt based on template and requirements
   */
  generatePrompt(
    template: PromptTemplate,
    projectDescription: string,
    selectedFeatures: string[],
    customRequirements?: string[],
    attachedDocuments?: { documentType: string; content: string }[],
    docsPath?: string
  ): string {
    const sections: string[] = [];

    // Header
    sections.push(this.generateHeader(template, projectDescription));

    // Project Overview
    sections.push(this.generateProjectOverview(projectDescription, selectedFeatures));

    // Project Reference Documents (hybrid: inline summary + file path)
    if (attachedDocuments && attachedDocuments.length > 0) {
      sections.push(this.generateDocumentsSection(attachedDocuments, docsPath || 'docs'));
    }

    // Architecture Guidelines
    sections.push(this.generateArchitectureSection(template.architecture));

    // Development Guidelines
    sections.push(this.generateGuidelinesSection(template.guidelines));

    // Coding Standards
    sections.push(this.generateStandardsSection(template.standards));

    // Required Libraries and Dependencies
    sections.push(this.generateLibrariesSection(template.libraries));

    // Security Considerations
    sections.push(this.generateSecuritySection(template.security));

    // Performance Guidelines
    sections.push(this.generatePerformanceSection(template.performance));

    // Best Practices
    sections.push(this.generateBestPracticesSection(template.bestPractices));

    // Testing Requirements
    sections.push(this.generateTestingSection(template.testing));

    // Deployment Guidelines
    sections.push(this.generateDeploymentSection(template.deployment));

    // Critical Precautions
    sections.push(this.generatePrecautionsSection(template.precautions));

    // Custom Requirements
    if (customRequirements && customRequirements.length > 0) {
      sections.push(this.generateCustomRequirementsSection(customRequirements));
    }

    // Custom Sections
    if (template.customSections && template.customSections.length > 0) {
      sections.push(this.generateCustomSections(template.customSections));
    }

    // Implementation Instructions
    sections.push(this.generateImplementationInstructions(template.applicationType));

    // Footer
    sections.push(this.generateFooter());

    return sections.join('\n\n');
  }

  /**
   * Generate a "Project Reference Documents" section with inline summaries + file path references
   */
  private generateDocumentsSection(
    documents: { documentType: string; content: string }[],
    docsPath: string
  ): string {
    const docTypeLabels: Record<string, string> = {
      prd: 'Product Requirements Document (PRD)',
      requirements: 'Requirements Specification',
      techstack: 'Technology Stack & Architecture',
      frontend: 'Frontend Implementation Guide',
      backend: 'Backend Implementation Guide',
      flow: 'Application Flow & User Journeys',
      status: 'Project Status & Progress',
    };

    const docSections = documents.map(doc => {
      const label = docTypeLabels[doc.documentType] || doc.documentType;
      const fileName = `${doc.documentType}.md`;

      // Extract a summary: first ~500 chars, trimmed to last complete sentence/line
      let summary = doc.content.substring(0, 500);
      const lastNewline = summary.lastIndexOf('\n');
      if (lastNewline > 200) {
        summary = summary.substring(0, lastNewline);
      }
      if (summary.length < doc.content.length) {
        summary += '\n...';
      }

      return `### ${label}\n\n${summary}\n\n📄 **Full document**: @${docsPath}/${fileName}`;
    });

    return `## 📋 Project Reference Documents\n\n> **Note for AI coding tools**: Read the full documents referenced below for complete context before implementing.\n\n${docSections.join('\n\n---\n\n')}`;
  }

  private generateHeader(template: PromptTemplate, projectDescription: string): string {
    return `# ${template.applicationType.toUpperCase()} Application Development Prompt

## Application Type: ${this.formatApplicationType(template.applicationType)}
## Category: ${this.formatCategory(template.category)}
## Template: ${template.name}

---

**IMPORTANT**: This is a comprehensive development prompt for building a ${template.applicationType} application. Follow ALL guidelines, standards, and precautions outlined below for optimal code quality, security, and maintainability.

## Project Description
${projectDescription}`;
  }

  private generateProjectOverview(projectDescription: string, selectedFeatures: string[]): string {
    return `## 🎯 Project Overview

**Description**: ${projectDescription}

**Key Features to Implement**:
${selectedFeatures.map(feature => `- ${feature}`).join('\n')}

**Development Approach**: Follow the guidelines and standards outlined in this prompt to ensure high-quality, maintainable, and secure code.`;
  }

  private generateArchitectureSection(architecture: ArchitectureGuidelines): string {
    // Helper to format a value that might be array, string, or object
    const formatValue = (value: any, defaultMsg: string): string => {
      if (!value) return defaultMsg;
      if (Array.isArray(value)) {
        return value.map(item => `- ${item}`).join('\n');
      }
      if (typeof value === 'string') {
        return `- ${value}`;
      }
      if (typeof value === 'object') {
        return Object.entries(value).map(([k, v]) => {
          if (Array.isArray(v)) {
            return `- **${k}**: ${v.join(', ')}`;
          }
          return `- **${k}**: ${v}`;
        }).join('\n');
      }
      return defaultMsg;
    };

    return `## 🏗️ Architecture Guidelines

**Pattern**:
${formatValue(architecture.pattern, 'No pattern specified')}

**Description**:
${formatValue(architecture.description, 'No description specified')}

**Structure**:
${formatValue(architecture.structure, 'No structure specified')}

**Data Flow**:
${formatValue(architecture.dataFlow, 'No data flow specified')}

**State Management**:
${formatValue(architecture.stateManagement, 'No state management specified')}

**API Design**:
${formatValue(architecture.apiDesign, 'No API design specified')}`;
  }


  private generateGuidelinesSection(guidelines: any): string {
    let section = `## 📋 Development Guidelines

`;

    if (guidelines.architecture) {
      section += `### Architecture Guidelines
${guidelines.architecture.map((item: string) => `- ${item}`).join('\n')}

`;
    }

    if (guidelines.structure) {
      section += `### Structure Guidelines
${guidelines.structure.map((item: string) => `- ${item}`).join('\n')}

`;
    }

    if (guidelines.performance) {
      section += `### Performance Guidelines
${guidelines.performance.map((item: string) => `- ${item}`).join('\n')}

`;
    }

    return section;
  }

  private generateStandardsSection(standards: any): string {
    let section = `## 📏 Coding Standards

`;

    if (standards.naming) {
      section += `### Naming Conventions
${standards.naming.map((item: string) => `- ${item}`).join('\n')}

`;
    }

    if (standards.formatting) {
      section += `### Code Formatting
${standards.formatting.map((item: string) => `- ${item}`).join('\n')}

`;
    }

    if (standards.documentation) {
      section += `### Documentation Standards
${standards.documentation.map((item: string) => `- ${item}`).join('\n')}

`;
    }

    return section;
  }

  private generateLibrariesSection(libraries: any): string {
    let section = `## 📚 Required Libraries and Dependencies

`;

    if (libraries.core) {
      section += `### Core Libraries
${libraries.core.map((item: string) => `- ${item}`).join('\n')}

`;
    }

    if (libraries.ui) {
      section += `### UI Libraries
${libraries.ui.map((item: string) => `- ${item}`).join('\n')}

`;
    }

    if (libraries.utilities) {
      section += `### Utility Libraries
${libraries.utilities.map((item: string) => `- ${item}`).join('\n')}

`;
    }

    return section;
  }

  private generateSecuritySection(security: any): string {
    let section = `## 🔒 Security Considerations

`;

    if (security.authentication) {
      section += `### Authentication Security
${security.authentication.map((item: string) => `- ${item}`).join('\n')}

`;
    }

    if (security.dataProtection) {
      section += `### Data Protection
${security.dataProtection.map((item: string) => `- ${item}`).join('\n')}

`;
    }

    if (security.dependencies) {
      section += `### Dependency Security
${security.dependencies.map((item: string) => `- ${item}`).join('\n')}

`;
    }

    return section;
  }

  private generatePerformanceSection(performance: any): string {
    let section = `## ⚡ Performance Guidelines

`;

    if (performance.optimization) {
      section += `### Performance Optimization
${performance.optimization.map((item: string) => `- ${item}`).join('\n')}

`;
    }

    if (performance.monitoring) {
      section += `### Performance Monitoring
${performance.monitoring.map((item: string) => `- ${item}`).join('\n')}

`;
    }

    if (performance.loading) {
      section += `### Loading Performance
${performance.loading.map((item: string) => `- ${item}`).join('\n')}

`;
    }

    return section;
  }

  private generateBestPracticesSection(bestPractices: BestPracticeItem[]): string {
    const grouped = bestPractices.reduce((acc, practice) => {
      if (!acc[practice.category]) acc[practice.category] = [];
      acc[practice.category].push(practice);
      return acc;
    }, {} as Record<string, BestPracticeItem[]>);

    let section = `## ✨ Best Practices`;

    Object.entries(grouped).forEach(([category, practices]) => {
      section += `\n\n### ${category.charAt(0).toUpperCase() + category.slice(1)} Best Practices`;
      practices.forEach(practice => {
        section += `\n\n**${practice.title}**
${practice.description}
**Implementation**: ${practice.implementation}
**Benefits**: ${practice.benefits.join(', ')}`;
        if (practice.examples && practice.examples.length > 0) {
          section += `\n**Examples**: ${practice.examples.join(', ')}`;
        }
      });
    });

    return section;
  }

  private generateTestingSection(testing: any): string {
    let section = `## 🧪 Testing Guidelines
  
  `;

    if (testing.unit) {
      section += `### Unit Testing
  ${testing.unit.map((item: string) => `- ${item}`).join('\n')}
  
  `;
    }

    if (testing.integration) {
      section += `### Integration Testing
  ${testing.integration.map((item: string) => `- ${item}`).join('\n')}
  
  `;
    }

    if (testing.e2e) {
      section += `### End-to-End Testing
  ${testing.e2e.map((item: string) => `- ${item}`).join('\n')}
  
  `;
    }

    return section;
  }

  private generateDeploymentSection(deployment: any): string {
    let section = `## 🚀 Deployment Guidelines
  
  `;

    if (deployment.build) {
      section += `### Build Configuration
  ${deployment.build.map((item: string) => `- ${item}`).join('\n')}
  
  `;
    }

    if (deployment.hosting) {
      section += `### Hosting Setup
  ${deployment.hosting.map((item: string) => `- ${item}`).join('\n')}
  
  `;
    }

    if (deployment.cicd) {
      section += `### CI/CD Pipeline
  ${deployment.cicd.map((item: string) => `- ${item}`).join('\n')}
  
  `;
    }

    return section;
  }

  private generatePrecautionsSection(precautions: any): string {
    let section = `## ⚠️ Critical Precautions

`;

    if (precautions.common_issues) {
      section += `### Common Issues to Avoid
${precautions.common_issues.map((item: string) => `- ${item}`).join('\n')}

`;
    }

    if (precautions.performance_pitfalls) {
      section += `### Performance Pitfalls
${precautions.performance_pitfalls.map((item: string) => `- ${item}`).join('\n')}

`;
    }

    if (precautions.security_risks) {
      section += `### Security Risks
${precautions.security_risks.map((item: string) => `- ${item}`).join('\n')}

`;
    }

    return section;
  }

  private generateCustomRequirementsSection(customRequirements: string[]): string {
    return `## 🎯 Custom Requirements

${customRequirements.map(req => `- ${req}`).join('\n')}`;
  }

  private generateCustomSections(customSections: CustomSection[]): string {
    const sortedSections = customSections.sort((a, b) => a.order - b.order);

    let section = `## 📝 Additional Guidelines`;

    sortedSections.forEach(custom => {
      section += `\n\n### ${custom.title}`;

      switch (custom.type) {
        case 'list':
          const items = custom.content.split('\n').filter(item => item.trim());
          section += `\n${items.map(item => `- ${item.trim()}`).join('\n')}`;
          break;
        case 'code':
          section += `\n\`\`\`\n${custom.content}\n\`\`\``;
          break;
        case 'checklist':
          const checkItems = custom.content.split('\n').filter(item => item.trim());
          section += `\n${checkItems.map(item => `- [ ] ${item.trim()}`).join('\n')}`;
          break;
        default:
          section += `\n${custom.content}`;
      }
    });

    return section;
  }

  private generateImplementationInstructions(applicationType: ApplicationType): string {
    const instructions = this.getImplementationInstructions(applicationType);

    return `## 🛠️ Implementation Instructions

${instructions}

### Development Workflow
1. **Setup**: Initialize project with proper structure and dependencies
2. **Core Implementation**: Build core functionality following architecture guidelines
3. **Security**: Implement security measures as outlined above
4. **Testing**: Write comprehensive tests for all components
5. **Performance**: Optimize based on performance guidelines
6. **Documentation**: Document all APIs, components, and deployment procedures
7. **Deployment**: Follow deployment guidelines for chosen platform

### Quality Checklist
- [ ] All security requirements implemented
- [ ] Performance optimizations applied
- [ ] Comprehensive test coverage achieved
- [ ] Code follows all coding standards
- [ ] Documentation is complete and accurate
- [ ] Deployment configuration is ready`;
  }

  private generateFooter(): string {
    return `---

## 📚 Final Notes

**Remember**: This prompt contains comprehensive guidelines for building a high-quality application. Prioritize security, performance, and maintainability throughout the development process.

**Code Quality**: Follow all coding standards and best practices outlined above.
**Security First**: Never compromise on security requirements.
**Performance**: Optimize early and measure continuously.
**Testing**: Maintain high test coverage and quality.

**Good luck with your development!** 🚀`;
  }

  // Helper methods for formatting
  private formatApplicationType(type: ApplicationType): string {
    const typeMap: Record<ApplicationType, string> = {
      'web': 'Web Application',
      'mobile': 'Mobile Application',
      'rag': 'RAG (Retrieval-Augmented Generation)',
      'api': 'API/Backend Service',
      'desktop': 'Desktop Application',
      'ml': 'Machine Learning',
      'blockchain': 'Blockchain Application',
      'iot': 'IoT Application',
      'game': 'Game Development',
      'cli': 'Command Line Interface',
      'microservice': 'Microservice',
      'chrome-extension': 'Chrome Extension',
      'electron': 'Electron Application',
      'pwa': 'Progressive Web App'
    };
    return typeMap[type] || type;
  }

  private formatCategory(category: ApplicationCategory): string {
    const categoryMap: Record<ApplicationCategory, string> = {
      'frontend': 'Frontend Development',
      'backend': 'Backend Development',
      'fullstack': 'Full-Stack Development',
      'ai': 'AI/Machine Learning',
      'data': 'Data Engineering',
      'devops': 'DevOps/Infrastructure',
      'security': 'Security',
      'testing': 'Testing/QA',
      'infrastructure': 'Infrastructure'
    };
    return categoryMap[category] || category;
  }

  private formatStandardType(type: string): string {
    const typeMap: Record<string, string> = {
      'coding': 'Code Quality',
      'naming': 'Naming Convention',
      'structure': 'Project Structure',
      'documentation': 'Documentation',
      'git': 'Git Workflow'
    };
    return typeMap[type] || type;
  }

  private formatLibraryCategory(category: string): string {
    const categoryMap: Record<string, string> = {
      'ui': 'User Interface',
      'state': 'State Management',
      'routing': 'Routing',
      'testing': 'Testing',
      'build': 'Build Tools',
      'utility': 'Utilities',
      'database': 'Database',
      'auth': 'Authentication',
      'api': 'API/HTTP'
    };
    return categoryMap[category] || category;
  }

  private formatTestType(type: string): string {
    const typeMap: Record<string, string> = {
      'unit': 'Unit',
      'integration': 'Integration',
      'e2e': 'End-to-End',
      'performance': 'Performance',
      'security': 'Security'
    };
    return typeMap[type] || type;
  }

  private getImplementationInstructions(applicationType: ApplicationType): string {
    const instructionsMap: Record<ApplicationType, string> = {
      'web': 'Build a responsive web application with modern frontend framework. Ensure cross-browser compatibility and accessibility.',
      'mobile': 'Develop a native or cross-platform mobile application. Focus on mobile-specific UX patterns and performance.',
      'rag': 'Implement a Retrieval-Augmented Generation system with proper vector storage, embedding generation, and context retrieval.',
      'api': 'Create a RESTful or GraphQL API with proper authentication, validation, and documentation.',
      'desktop': 'Build a desktop application with native OS integration and proper resource management.',
      'ml': 'Develop a machine learning solution with proper data preprocessing, model training, and inference pipelines.',
      'blockchain': 'Create blockchain application with smart contracts, proper security, and decentralized architecture.',
      'iot': 'Build IoT application with device communication, data collection, and real-time processing.',
      'game': 'Develop game with proper game loop, asset management, and performance optimization.',
      'cli': 'Create command-line interface with proper argument parsing, help system, and error handling.',
      'microservice': 'Build microservice with proper service discovery, communication, and monitoring.',
      'chrome-extension': 'Develop Chrome extension with proper manifest, permissions, and browser API usage.',
      'electron': 'Create Electron application with proper main/renderer process communication and native integration.',
      'pwa': 'Build Progressive Web App with service workers, offline functionality, and app-like experience.'
    };

    return instructionsMap[applicationType] || 'Follow the guidelines above to implement your application.';
  }
}
