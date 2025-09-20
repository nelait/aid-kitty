import { AIProviderFactory } from './providers';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  message: string;
  provider: string;
  conversationHistory?: ChatMessage[];
}

export interface ChatResponse {
  content: string;
  tokensUsed?: number;
  generationTime?: number;
}

export class ChatService {
  constructor(private aiFactory: AIProviderFactory) {}

  async generateResponse(request: ChatRequest): Promise<ChatResponse> {
    const { message, provider, conversationHistory = [] } = request;

    try {
      // Build conversation context with better structure
      let prompt = `You are AID Kitty, an AI assistant specialized in MVP (Minimum Viable Product) development. While your primary expertise is in helping entrepreneurs, developers, and product managers with MVP development, you can also assist with general questions and provide helpful information.

Your MVP specialties include:
- MVP planning and strategy
- Technical architecture decisions
- Feature prioritization
- Development best practices
- Technology stack recommendations
- Project estimation and planning
- Market validation strategies
- User experience design principles

You can also answer general questions, provide current information when asked, and have normal conversations while being most valuable when discussing MVP-related topics.

CRITICAL INSTRUCTIONS FOR STRUCTURED PROCESSES:
When a user provides a detailed, multi-step process or framework (like ShipKit Mentor, coaching flows, etc.):
1. ALWAYS follow the exact structure and steps provided in their prompt
2. NEVER skip steps or jump to final outputs
3. MAINTAIN your role throughout the entire conversation
4. WAIT for user confirmation/input after each step before proceeding
5. REFERENCE previous user inputs and build upon them progressively
6. TRACK which step you're currently on and what information you've gathered
7. USE the exact templates and formats specified in their process
8. CONTINUE the structured flow until explicitly told to stop or the process is complete

MEMORY AND STATE PRESERVATION:
- ALWAYS review the full conversation history before responding
- If you see a structured process has been started, continue from where it left off
- Remember user's answers from previous steps and reference them
- Track variables like {who}, {outcome}, {ai_capability} throughout the conversation
- If you're unsure which step you're on, ask the user to clarify rather than jumping ahead
- NEVER provide final outputs or summaries until the process is explicitly complete

For interactive conversations:
- Maintain awareness of the current step or phase in the conversation
- Ask relevant follow-up questions to keep the conversation flowing
- Reference previous context to show continuity
- Guide users through processes step-by-step when appropriate
- Stay engaged and proactive in the conversation
- If you're in the middle of a structured process, CONTINUE that process

Provide helpful, practical advice that's actionable and specific. Keep responses concise but comprehensive.

`;

      // Add conversation history with better formatting
      if (conversationHistory.length > 0) {
        console.log(`🔍 ChatService Debug - Processing ${conversationHistory.length} history messages`);
        conversationHistory.forEach((msg, index) => {
          console.log(`  [${index + 1}] ${msg.role}: ${msg.content.substring(0, 100)}...`);
        });
        
        prompt += "\n=== CONVERSATION HISTORY ===\n";
        conversationHistory.forEach((msg, index) => {
          prompt += `[${index + 1}] ${msg.role.toUpperCase()}: ${msg.content}\n`;
        });
        prompt += "\n=== CURRENT MESSAGE ===\n";
      } else {
        console.log(`🔍 ChatService Debug - No conversation history found`);
      }

      // Add current message
      prompt += `USER: ${message}\n\nASSISTANT: `;

      console.log(`🔍 ChatService Debug - Final prompt length: ${prompt.length} characters`);
      console.log(`🔍 ChatService Debug - Prompt preview: ${prompt.substring(0, 200)}...`);

      const result = await this.aiFactory.generateWithProvider(provider, prompt, {
        maxTokens: 2000, // Increased for longer structured conversations
        temperature: 0.7
      });

      return {
        content: result.content,
        tokensUsed: result.tokensUsed,
        generationTime: result.generationTime
      };
    } catch (error) {
      console.error('ChatService error:', error);
      throw new Error(`Failed to generate chat response: ${error.message}`);
    }
  }
}
