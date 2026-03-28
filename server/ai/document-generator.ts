import { AIProviderFactory, GenerationResult } from './providers';

export interface DocumentGenerationRequest {
    requirements: string;
    projectTitle: string;
    documentType: DocumentType;
    provider: string;
    estimationSettings?: any;
}

export type DocumentType =
    | 'prd'
    | 'requirements'
    | 'techstack'
    | 'frontend'
    | 'backend'
    | 'flow'
    | 'status'
    | 'estimation'
    | 'diagram_component'
    | 'diagram_sequence'
    | 'diagram_architecture';

export interface GeneratedDocument {
    filename: string;
    content: string;
    type: DocumentType;
}

export class DocumentGenerator {
    constructor(private aiFactory: AIProviderFactory) { }

    private buildPrompt(documentType: DocumentType, requirements: string, projectTitle: string, estimationSettings?: any): string {
        const baseContext = `Project: ${projectTitle}\n\nRequirements:\n${requirements}\n\n`;

        const prompts: Record<DocumentType, string> = {
            prd: `${baseContext}You are a Product Manager creating a detailed PRD for this project.

Create a detailed PRD that ONLY addresses what's described above. Format as markdown with these sections:
1. Introduction - Describe exactly what was requested
2. Product Specifications - Detail the features mentioned
3. User Experience - Describe how users will interact with the system
4. Implementation Requirements - Note technical requirements mentioned

Be specific and detailed but practical. Focus on information developers need to implement the product.`,

            requirements: `${baseContext}You are a Senior Business Analyst creating a detailed requirements document for this project.

Create a detailed requirements document that ONLY addresses what's described above. Format as markdown with these sections:
1. Project Overview - Describe exactly what was requested
2. Functional Requirements - List all features mentioned
3. Non-Functional Requirements - Include any performance/technical requirements mentioned
4. Dependencies and Constraints - Note any limitations or integrations mentioned

Be specific and detailed but concise. Focus on clarity and actionable information.`,

            techstack: `${baseContext}You are a Software Architect recommending technology choices for this project.

Recommend appropriate technologies that would work well for this specific project. Format as markdown with these sections:
1. Frontend Technologies - Appropriate for the described UI needs
2. Backend Technologies - Suitable for the described functionality
3. Database - Appropriate for the data requirements
4. Infrastructure - Deployment and hosting considerations

Focus on practical, maintainable choices that align with current best practices. Include brief justifications for major technology decisions.`,

            backend: `${baseContext}You are a Backend Engineer designing an implementation guide for this project.

Create a practical backend implementation plan in markdown format with these sections:
1. Document Header - Include "Version: 1.0" and "Date: ${new Date().toLocaleDateString()}"
2. API Design - Document key endpoints, methods, and payloads
3. Data Models - Outline essential database tables/collections with fields
4. Business Logic - Describe core backend processes
5. Security - Explain authentication and authorization approach
6. Performance - Suggest optimization strategies
7. Code Examples - Provide sample code for key functions

Focus on providing clear, usable guidance. Include practical code examples for the most important functionality.`,

            frontend: `${baseContext}You are a Frontend Developer creating an implementation guide for this project.

Create a detailed frontend implementation guide specifically for this project. Format as markdown with these sections:
1. Component Structure - UI components needed for the described features
2. State Management - How to handle data for the described functionality
3. UI/UX Guidelines - Visual design considerations
4. Code Examples - Sample components and logic for key features

Focus on providing actionable guidance with practical code examples for the most important components.`,

            flow: `${baseContext}You are a Solutions Architect creating flow documentation for this project.

Create system flow documentation specifically for this project. Format as markdown with these sections:
1. User Workflows - How users will interact with the system
2. Data Flows - How data moves through the system
3. Integration Points - How components connect
4. Error Handling - How to manage failures

Include simple mermaid diagrams for the most critical flows (user journeys and data flows).
Focus on clarity and practical information that guides development.`,

            status: `${baseContext}You are a Project Manager creating a project status template for this project.

Create a project status tracking template specifically for this project. Format as markdown with these sections:
1. Implementation Phases - Based on the specific features mentioned
2. Milestone Checklist - Concrete deliverables from the requirements
3. Testing Criteria - What needs to be tested based on the features
4. Deployment Stages - How this specific project should be deployed

Focus on creating a practical tracking template that can be used throughout development.`,

            estimation: `${baseContext}You are a Senior Project Estimator creating a detailed Function Point Analysis (FPA) estimation for this project.

Create a comprehensive project estimation document using Function Point Analysis methodology. Output as a complete HTML document that will render as a professional webpage:

<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Project Estimation Report - ${projectTitle}</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background: #f8fafc;
        }
        .container {
            background: white;
            border-radius: 12px;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
            padding: 40px;
            margin: 20px 0;
        }
        .header {
            text-align: center;
            border-bottom: 3px solid #3b82f6;
            padding-bottom: 20px;
            margin-bottom: 30px;
        }
        h1 {
            color: #1e40af;
            font-size: 2.5rem;
            margin-bottom: 10px;
        }
        h2 {
            color: #1e40af;
            font-size: 1.8rem;
            margin-top: 30px;
            margin-bottom: 15px;
            border-left: 4px solid #3b82f6;
            padding-left: 15px;
        }
        h3 {
            color: #374151;
            font-size: 1.3rem;
            margin-top: 25px;
            margin-bottom: 10px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin: 20px 0;
            background: white;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        th, td {
            padding: 12px 15px;
            text-align: left;
            border-bottom: 1px solid #e5e7eb;
        }
        th {
            background: #f3f4f6;
            font-weight: 600;
            color: #374151;
        }
        tr:hover {
            background: #f9fafb;
        }
        .metric-box {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
            border-radius: 10px;
            margin: 15px 0;
            text-align: center;
        }
        .metric-value {
            font-size: 2rem;
            font-weight: bold;
            margin-bottom: 5px;
        }
        .risk-low { background: #dcfce7; color: #166534; }
        .risk-medium { background: #fef3c7; color: #92400e; }
        .risk-high { background: #fee2e2; color: #991b1b; }
        .confidence-high { background: #dcfce7; color: #166534; }
        .confidence-medium { background: #fef3c7; color: #92400e; }
        .confidence-low { background: #fee2e2; color: #991b1b; }
        .summary-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin: 20px 0;
        }
        .summary-card {
            background: #f8fafc;
            padding: 20px;
            border-radius: 8px;
            border-left: 4px solid #3b82f6;
        }
        .emoji {
            font-size: 1.2em;
            margin-right: 8px;
        }
        .date {
            color: #6b7280;
            font-size: 0.9rem;
        }
        .methodology {
            background: #eff6ff;
            padding: 20px;
            border-radius: 8px;
            margin: 20px 0;
            border-left: 4px solid #2563eb;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1><span class="emoji">📊</span>Project Estimation Report</h1>
            <p><strong>Project:</strong> ${projectTitle}</p>
            <p class="date">Generated: ${new Date().toLocaleDateString()}</p>
            <p><em>Function Point Analysis (FPA) Methodology</em></p>
        </div>

        <h2><span class="emoji">🎯</span>Executive Summary</h2>
        <div class="summary-grid">
            <div class="summary-card">
                <h3>Total Function Points</h3>
                <div class="metric-value">[Calculate AFP total]</div>
                <p>Adjusted Function Points</p>
            </div>
            <div class="summary-card">
                <h3>Estimated Effort</h3>
                <div class="metric-value">[Calculate total hours]</div>
                <p>Development Hours</p>
            </div>
            <div class="summary-card">
                <h3>Project Cost</h3>
                <div class="metric-value">$[Calculate total cost]</div>
                <p>Total Investment</p>
            </div>
            <div class="summary-card">
                <h3>Timeline</h3>
                <div class="metric-value">[Calculate weeks]</div>
                <p>Estimated Weeks</p>
            </div>
        </div>

        <h2><span class="emoji">🔢</span>Function Point Analysis</h2>
        
        <h3>📋 Function Point Counting Methodology</h3>
        <div class="methodology">
            <p><strong>IMPORTANT:</strong> The following section provides detailed analysis of how each function point count was derived from the project requirements. This justifies the estimation foundation.</p>
        </div>

        <h4>🔍 Detailed Function Analysis & Counting Justification</h4>
        
        <h5>External Inputs (EI) - Data Entry Functions</h5>
        <div class="summary-card">
            <p><strong>Definition:</strong> User input screens, forms, API endpoints that add, change, or delete data</p>
            <p><strong>Analysis Instructions:</strong> Identify each unique data entry point from requirements and categorize by complexity:</p>
            <ul>
                <li><strong>Simple (${estimationSettings?.complexityWeights?.simple?.inputs || 3} FP):</strong> Basic forms with 1-5 data elements, minimal validation</li>
                <li><strong>Average (${estimationSettings?.complexityWeights?.average?.inputs || 4} FP):</strong> Forms with 6-15 data elements, moderate validation/business rules</li>
                <li><strong>Complex (${estimationSettings?.complexityWeights?.complex?.inputs || 6} FP):</strong> Forms with 16+ data elements, complex validation, multiple file types</li>
            </ul>
            <p><strong>Identified Functions:</strong></p>
            <table style="margin: 10px 0;">
                <thead>
                    <tr><th>Function Name</th><th>Description</th><th>Data Elements</th><th>Complexity</th><th>Justification</th></tr>
                </thead>
                <tbody>
                    <tr><td colspan="5"><em>[List each EI function identified from requirements with detailed justification]</em></td></tr>
                </tbody>
            </table>
        </div>

        <h5>External Outputs (EO) - Reports & Derived Data</h5>
        <div class="summary-card">
            <p><strong>Definition:</strong> Reports, screens, files with calculated/derived data sent outside application boundary</p>
            <p><strong>Analysis Instructions:</strong> Identify reports and outputs that perform calculations or data processing:</p>
            <ul>
                <li><strong>Simple (${estimationSettings?.complexityWeights?.simple?.outputs || 4} FP):</strong> Basic reports with 1-5 data elements, minimal calculations</li>
                <li><strong>Average (${estimationSettings?.complexityWeights?.average?.outputs || 5} FP):</strong> Reports with 6-19 data elements, moderate calculations</li>
                <li><strong>Complex (${estimationSettings?.complexityWeights?.complex?.outputs || 7} FP):</strong> Reports with 20+ data elements, complex calculations, multiple formats</li>
            </ul>
            <p><strong>Identified Functions:</strong></p>
            <table style="margin: 10px 0;">
                <thead>
                    <tr><th>Function Name</th><th>Description</th><th>Data Elements</th><th>Complexity</th><th>Justification</th></tr>
                </thead>
                <tbody>
                    <tr><td colspan="5"><em>[List each EO function identified from requirements with detailed justification]</em></td></tr>
                </tbody>
            </table>
        </div>

        <h5>External Inquiries (EQ) - Search & Lookup Functions</h5>
        <div class="summary-card">
            <p><strong>Definition:</strong> Search functions, lookup screens, queries that retrieve data without calculations</p>
            <p><strong>Analysis Instructions:</strong> Identify search and retrieval functions from requirements:</p>
            <ul>
                <li><strong>Simple (${estimationSettings?.complexityWeights?.simple?.inquiries || 3} FP):</strong> Basic search with 1-5 search criteria, simple result display</li>
                <li><strong>Average (${estimationSettings?.complexityWeights?.average?.inquiries || 4} FP):</strong> Search with 6-19 criteria/results, moderate filtering</li>
                <li><strong>Complex (${estimationSettings?.complexityWeights?.complex?.inquiries || 6} FP):</strong> Advanced search with 20+ criteria, complex filtering, multiple result formats</li>
            </ul>
            <p><strong>Identified Functions:</strong></p>
            <table style="margin: 10px 0;">
                <thead>
                    <tr><th>Function Name</th><th>Description</th><th>Search Criteria</th><th>Complexity</th><th>Justification</th></tr>
                </thead>
                <tbody>
                    <tr><td colspan="5"><em>[List each EQ function identified from requirements with detailed justification]</em></td></tr>
                </tbody>
            </table>
        </div>

        <h5>Internal Logical Files (ILF) - Data Stores</h5>
        <div class="summary-card">
            <p><strong>Definition:</strong> Data groups/entities maintained within application boundary (database tables, data structures)</p>
            <p><strong>Analysis Instructions:</strong> Identify data entities and their relationships from requirements:</p>
            <ul>
                <li><strong>Simple (${estimationSettings?.complexityWeights?.simple?.files || 7} FP):</strong> 1-19 data elements, 1 record type</li>
                <li><strong>Average (${estimationSettings?.complexityWeights?.average?.files || 10} FP):</strong> 20-50 data elements, 2-5 record types</li>
                <li><strong>Complex (${estimationSettings?.complexityWeights?.complex?.files || 15} FP):</strong> 51+ data elements, 6+ record types</li>
            </ul>
            <p><strong>Identified Data Entities:</strong></p>
            <table style="margin: 10px 0;">
                <thead>
                    <tr><th>Entity Name</th><th>Description</th><th>Data Elements</th><th>Record Types</th><th>Complexity</th><th>Justification</th></tr>
                </thead>
                <tbody>
                    <tr><td colspan="6"><em>[List each ILF identified from requirements with detailed justification]</em></td></tr>
                </tbody>
            </table>
        </div>

        <h5>External Interface Files (EIF) - External System Interfaces</h5>
        <div class="summary-card">
            <p><strong>Definition:</strong> Data groups referenced by application but maintained by other applications (APIs, external databases)</p>
            <p><strong>Analysis Instructions:</strong> Identify external system integrations from requirements:</p>
            <ul>
                <li><strong>Simple (${estimationSettings?.complexityWeights?.simple?.interfaces || 5} FP):</strong> 1-19 data elements, 1 record type, basic integration</li>
                <li><strong>Average (${estimationSettings?.complexityWeights?.average?.interfaces || 7} FP):</strong> 20-50 data elements, 2-5 record types, moderate integration</li>
                <li><strong>Complex (${estimationSettings?.complexityWeights?.complex?.interfaces || 10} FP):</strong> 51+ data elements, 6+ record types, complex integration</li>
            </ul>
            <p><strong>Identified External Interfaces:</strong></p>
            <table style="margin: 10px 0;">
                <thead>
                    <tr><th>Interface Name</th><th>Description</th><th>Data Elements</th><th>Integration Type</th><th>Complexity</th><th>Justification</th></tr>
                </thead>
                <tbody>
                    <tr><td colspan="6"><em>[List each EIF identified from requirements with detailed justification]</em></td></tr>
                </tbody>
            </table>
        </div>

        <h3>Unadjusted Function Points (UFP)</h3>
        <table>
            <thead>
                <tr>
                    <th>Function Type</th>
                    <th>Simple</th>
                    <th>Average</th>
                    <th>Complex</th>
                    <th>Total Count</th>
                    <th>Weighted FP</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td><strong>External Inputs (EI)</strong></td>
                    <td>[Count] × ${estimationSettings?.complexityWeights?.simple?.inputs || 3}</td>
                    <td>[Count] × ${estimationSettings?.complexityWeights?.average?.inputs || 4}</td>
                    <td>[Count] × ${estimationSettings?.complexityWeights?.complex?.inputs || 6}</td>
                    <td>[Total EI]</td>
                    <td><strong>[EI FP]</strong></td>
                </tr>
                <tr>
                    <td><strong>External Outputs (EO)</strong></td>
                    <td>[Count] × ${estimationSettings?.complexityWeights?.simple?.outputs || 4}</td>
                    <td>[Count] × ${estimationSettings?.complexityWeights?.average?.outputs || 5}</td>
                    <td>[Count] × ${estimationSettings?.complexityWeights?.complex?.outputs || 7}</td>
                    <td>[Total EO]</td>
                    <td><strong>[EO FP]</strong></td>
                </tr>
                <tr>
                    <td><strong>External Inquiries (EQ)</strong></td>
                    <td>[Count] × ${estimationSettings?.complexityWeights?.simple?.inquiries || 3}</td>
                    <td>[Count] × ${estimationSettings?.complexityWeights?.average?.inquiries || 4}</td>
                    <td>[Count] × ${estimationSettings?.complexityWeights?.complex?.inquiries || 6}</td>
                    <td>[Total EQ]</td>
                    <td><strong>[EQ FP]</strong></td>
                </tr>
                <tr>
                    <td><strong>Internal Files (ILF)</strong></td>
                    <td>[Count] × ${estimationSettings?.complexityWeights?.simple?.files || 7}</td>
                    <td>[Count] × ${estimationSettings?.complexityWeights?.average?.files || 10}</td>
                    <td>[Count] × ${estimationSettings?.complexityWeights?.complex?.files || 15}</td>
                    <td>[Total ILF]</td>
                    <td><strong>[ILF FP]</strong></td>
                </tr>
                <tr>
                    <td><strong>External Interfaces (EIF)</strong></td>
                    <td>[Count] × ${estimationSettings?.complexityWeights?.simple?.interfaces || 5}</td>
                    <td>[Count] × ${estimationSettings?.complexityWeights?.average?.interfaces || 7}</td>
                    <td>[Count] × ${estimationSettings?.complexityWeights?.complex?.interfaces || 10}</td>
                    <td>[Total EIF]</td>
                    <td><strong>[EIF FP]</strong></td>
                </tr>
                <tr style="background: #f3f4f6; font-weight: bold;">
                    <td><strong>TOTAL UFP</strong></td>
                    <td colspan="4">Sum of all weighted function points</td>
                    <td><strong>[Total UFP]</strong></td>
                </tr>
            </tbody>
        </table>

        <h3>Technical Complexity Factor (TCF)</h3>
        <p>Environmental factors assessment based on project characteristics:</p>
        <div class="metric-box">
            <div class="metric-value">TCF = [Calculate TCF value]</div>
            <p>Based on ${estimationSettings?.environmentalFactors ? Object.keys(estimationSettings.environmentalFactors).length : 14} environmental factors</p>
        </div>

        <h3>Adjusted Function Points (AFP)</h3>
        <div class="metric-box">
            <div class="metric-value">AFP = [UFP] × [TCF] = [Calculate final AFP]</div>
            <p>Final adjusted function point count</p>
        </div>

        <h2><span class="emoji">⏱️</span>Effort Estimation</h2>
        
        <table>
            <thead>
                <tr>
                    <th>Phase</th>
                    <th>Percentage</th>
                    <th>Hours</th>
                    <th>Duration</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>Requirements & Analysis</td>
                    <td>15%</td>
                    <td>[Calculate req hours]</td>
                    <td>[Calculate req days] days</td>
                </tr>
                <tr>
                    <td>Design & Architecture</td>
                    <td>20%</td>
                    <td>[Calculate design hours]</td>
                    <td>[Calculate design days] days</td>
                </tr>
                <tr>
                    <td>Development & Coding</td>
                    <td>40%</td>
                    <td>[Calculate dev hours]</td>
                    <td>[Calculate dev days] days</td>
                </tr>
                <tr>
                    <td>Testing & QA</td>
                    <td>20%</td>
                    <td>[Calculate test hours]</td>
                    <td>[Calculate test days] days</td>
                </tr>
                <tr>
                    <td>Deployment & Documentation</td>
                    <td>5%</td>
                    <td>[Calculate deploy hours]</td>
                    <td>[Calculate deploy days] days</td>
                </tr>
                <tr style="background: #f3f4f6; font-weight: bold;">
                    <td><strong>TOTAL</strong></td>
                    <td><strong>100%</strong></td>
                    <td><strong>[Total project hours]</strong></td>
                    <td><strong>[Total project days] days</strong></td>
                </tr>
            </tbody>
        </table>

        <h2><span class="emoji">💰</span>Cost Estimation</h2>
        
        <table>
            <thead>
                <tr>
                    <th>Cost Category</th>
                    <th>Hours</th>
                    <th>Rate</th>
                    <th>Amount</th>
                    <th>Percentage</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td><strong>Development</strong></td>
                    <td>[Calculate dev hours]</td>
                    <td>$${estimationSettings?.projectParameters?.hourlyRate || 75}/hr</td>
                    <td>$[Calculate dev cost]</td>
                    <td>[Dev %]%</td>
                </tr>
                <tr>
                    <td><strong>Testing & QA</strong></td>
                    <td>[Calculate test hours]</td>
                    <td>$${Math.round((estimationSettings?.projectParameters?.hourlyRate || 75) * 0.8)}/hr</td>
                    <td>$[Calculate test cost]</td>
                    <td>[Test %]%</td>
                </tr>
                <tr>
                    <td><strong>Project Management</strong></td>
                    <td>[Calculate PM hours]</td>
                    <td>$${Math.round((estimationSettings?.projectParameters?.hourlyRate || 75) * 1.2)}/hr</td>
                    <td>$[Calculate PM cost]</td>
                    <td>[PM %]%</td>
                </tr>
                <tr>
                    <td><strong>Architecture & Design</strong></td>
                    <td>[Calculate arch hours]</td>
                    <td>$${Math.round((estimationSettings?.projectParameters?.hourlyRate || 75) * 1.3)}/hr</td>
                    <td>$[Calculate arch cost]</td>
                    <td>[Arch %]%</td>
                </tr>
                <tr>
                    <td><strong>Buffer (${estimationSettings?.projectParameters?.bufferPercentage || 20}%)</strong></td>
                    <td>-</td>
                    <td>-</td>
                    <td>$[Calculate buffer amount]</td>
                    <td>${estimationSettings?.projectParameters?.bufferPercentage || 20}%</td>
                </tr>
                <tr style="background: #f3f4f6; font-weight: bold;">
                    <td><strong>TOTAL PROJECT COST</strong></td>
                    <td><strong>[Total hours]</strong></td>
                    <td>-</td>
                    <td><strong>$[Final total cost]</strong></td>
                    <td><strong>100%</strong></td>
                </tr>
            </tbody>
        </table>

        <h3>Cost Range Analysis</h3>
        <div class="summary-grid">
            <div class="summary-card">
                <h4>Optimistic (-15%)</h4>
                <div class="metric-value">$[Calculate optimistic cost]</div>
            </div>
            <div class="summary-card">
                <h4>Most Likely</h4>
                <div class="metric-value">$[Base cost calculation]</div>
            </div>
            <div class="summary-card">
                <h4>Pessimistic (+25%)</h4>
                <div class="metric-value">$[Calculate pessimistic cost]</div>
            </div>
        </div>

        <h2><span class="emoji">⚠️</span>Risk Assessment</h2>
        
        <table>
            <thead>
                <tr>
                    <th>Risk Factor</th>
                    <th>Probability</th>
                    <th>Impact</th>
                    <th>Risk Level</th>
                    <th>Mitigation Strategy</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>Technical Complexity</td>
                    <td>[Assess probability]</td>
                    <td>[Assess impact]</td>
                    <td><span class="risk-[level]">[Risk level]</span></td>
                    <td>[Mitigation approach]</td>
                </tr>
                <tr>
                    <td>Requirements Changes</td>
                    <td>[Assess probability]</td>
                    <td>[Assess impact]</td>
                    <td><span class="risk-[level]">[Risk level]</span></td>
                    <td>[Mitigation approach]</td>
                </tr>
                <tr>
                    <td>Resource Availability</td>
                    <td>[Assess probability]</td>
                    <td>[Assess impact]</td>
                    <td><span class="risk-[level]">[Risk level]</span></td>
                    <td>[Mitigation approach]</td>
                </tr>
                <tr>
                    <td>Integration Challenges</td>
                    <td>[Assess probability]</td>
                    <td>[Assess impact]</td>
                    <td><span class="risk-[level]">[Risk level]</span></td>
                    <td>[Mitigation approach]</td>
                </tr>
            </tbody>
        </table>

        <h2><span class="emoji">📈</span>Confidence Analysis</h2>
        
        <div class="summary-grid">
            <div class="summary-card">
                <h4>Estimation Confidence</h4>
                <div class="confidence-[level]" style="padding: 10px; border-radius: 5px; text-align: center; font-weight: bold;">
                    [Calculate confidence level]% Confidence
                </div>
                <p>[Confidence reasoning]</p>
            </div>
            <div class="summary-card">
                <h4>Key Assumptions</h4>
                <ul>
                    <li>[List key assumption 1]</li>
                    <li>[List key assumption 2]</li>
                    <li>[List key assumption 3]</li>
                </ul>
            </div>
        </div>

        <div class="methodology">
            <h2><span class="emoji">📋</span>Methodology Notes</h2>
            <p><strong>Function Point Analysis (FPA)</strong> is an industry-standard method for measuring software size and estimating development effort. This estimation is based on:</p>
            <ul>
                <li>Detailed analysis of functional requirements</li>
                <li>Standard FPA complexity weights and environmental factors</li>
                <li>Industry productivity rates: ${estimationSettings?.projectParameters?.productivityRate || 20} hours per function point</li>
                <li>Project buffer: ${estimationSettings?.projectParameters?.bufferPercentage || 20}% for risk mitigation</li>
            </ul>
            <p><em>This estimation should be reviewed and validated with stakeholders before project initiation.</em></p>
        </div>
    </div>
</body>
</html>

**IMPORTANT CALCULATION INSTRUCTIONS:**
Analyze the project requirements thoroughly and calculate ACTUAL numeric values for all placeholders marked with [Calculate...]. Do not leave any placeholders unfilled. Use the estimation settings provided and apply Function Point Analysis methodology to generate realistic, actionable numbers based on the project scope and complexity.`,

            diagram_component: `${baseContext}You are a Software Architect creating a Component Diagram. Create a Mermaid.js flowchart TB diagram showing system components grouped by layer (Frontend, Backend, Data, External) with relationships. Output a markdown file with a mermaid code block. Use subgraph for layers and arrows for dependencies. Generate based on the actual requirements.`,

            diagram_sequence: `${baseContext}You are a Software Architect creating Sequence Diagrams. Create Mermaid.js sequenceDiagram(s) showing 3-5 key user flows including authentication, data operations, and main features. Output a markdown file with mermaid code blocks for each flow. Use actors, participants, and proper arrow syntax (->> and -->>). Generate based on the actual requirements.`,

            diagram_architecture: `${baseContext}You are a Solutions Architect creating an Architecture Diagram. Create a Mermaid.js flowchart TB showing the high-level system architecture with layers, technology choices, external integrations, and data storage. Use subgraphs, descriptive labels, and show connections between components. Output a markdown file with a mermaid code block. Generate based on the actual requirements.`,
        };

        return prompts[documentType];
    }

    private getDocumentFilename(documentType: DocumentType): string {
        const filenames: Record<DocumentType, string> = {
            prd: 'prd.md',
            requirements: 'requirements.md',
            techstack: 'techstack.md',
            backend: 'backend.md',
            frontend: 'frontend.md',
            flow: 'flow.md',
            status: 'status.md',
            estimation: 'estimation.html',
            diagram_component: 'diagram_component.md',
            diagram_sequence: 'diagram_sequence.md',
            diagram_architecture: 'diagram_architecture.md'
        };

        return filenames[documentType];
    }

    async generateDocument(request: {
        requirements: string;
        projectTitle: string;
        documentType: DocumentType;
        provider: string;
        estimationSettings?: any;
    }): Promise<GeneratedDocument> {
        const prompt = this.buildPrompt(
            request.documentType,
            request.requirements,
            request.projectTitle,
            request.estimationSettings
        );

        // Use longer timeouts and more tokens for complex documents
        const isComplexDocument = ['backend', 'frontend', 'techstack', 'estimation'].includes(request.documentType);
        const options = {
            maxTokens: isComplexDocument ? 8192 : 4096,
            temperature: 0.7,
        };

        const result = await this.aiFactory.generateWithProvider(
            request.provider,
            prompt,
            options
        );

        // Validate content quality
        if (!result.content || result.content.trim().length < 100) {
            throw new Error(`Failed to generate meaningful content for ${request.documentType}`);
        }

        // Check for placeholder content that indicates failure
        if (result.content.includes("Please provide the requirements") ||
            result.content.includes("I need more information")) {
            throw new Error(`Generated content for ${request.documentType} is incomplete`);
        }

        return {
            filename: this.getDocumentFilename(request.documentType),
            content: result.content,
            type: request.documentType
        };
    }

    async generateAllDocuments(
        requirements: string,
        projectTitle: string,
        provider: string
    ): Promise<GeneratedDocument[]> {
        const documentTypes: DocumentType[] = [
            'prd',
            'requirements',
            'techstack',
            'backend',
            'frontend',
            'flow',
            'status',
            'estimation'
        ];

        const documents: GeneratedDocument[] = [];

        // Generate documents sequentially to avoid rate limits
        for (const documentType of documentTypes) {
            try {
                console.log(`Generating ${documentType} document...`);
                const document = await this.generateDocument({
                    requirements,
                    projectTitle,
                    documentType,
                    provider
                });
                documents.push(document);

                // Small delay between generations to be respectful to APIs
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                console.error(`Failed to generate ${documentType} document:`, error);
                // Continue with other documents even if one fails
            }
        }

        return documents;
    }

    async generateDocumentBatch(
        requirements: string,
        projectTitle: string,
        provider: string,
        documentTypes: DocumentType[]
    ): Promise<GeneratedDocument[]> {
        const documents: GeneratedDocument[] = [];

        for (const documentType of documentTypes) {
            try {
                console.log(`Generating ${documentType} document...`);
                const document = await this.generateDocument({
                    requirements,
                    projectTitle,
                    documentType,
                    provider
                });
                documents.push(document);

                // Small delay between generations
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                console.error(`Failed to generate ${documentType} document:`, error);
            }
        }

        return documents;
    }
}
