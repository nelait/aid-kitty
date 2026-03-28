import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';

export interface AIProvider {
  name: string;
  generateText(prompt: string, options?: any): Promise<string>;
  estimateTokens(text: string): number;
}

export interface GenerationResult {
  content: string;
  tokensUsed: number;
  model: string;
  generationTime: number;
}

// OpenAI Provider
export class OpenAIProvider implements AIProvider {
  name = 'openai';
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async generateText(prompt: string, options: any = {}): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: options.model || 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: options.maxTokens || 4000,
      temperature: options.temperature || 0.7,
    });

    return response.choices[0]?.message?.content || '';
  }

  estimateTokens(text: string): number {
    // Rough estimation: ~4 characters per token
    return Math.ceil(text.length / 4);
  }
}

// Anthropic Provider
export class AnthropicProvider implements AIProvider {
  name = 'anthropic';
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async generateText(prompt: string, options: any = {}): Promise<string> {
    const response = await this.client.messages.create({
      model: options.model || 'claude-3-5-sonnet-20241022',
      max_tokens: options.maxTokens || 4000,
      temperature: options.temperature || 0.7,
      messages: [{ role: 'user', content: prompt }],
    });

    return response.content[0]?.type === 'text' ? response.content[0].text : '';
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

// Google Provider
export class GoogleProvider implements AIProvider {
  name = 'google';
  private client: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async generateText(prompt: string, options: any = {}): Promise<string> {
    const model = this.client.getGenerativeModel({ 
      model: options.model || 'gemini-2.0-flash-exp'
    });

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: options.maxTokens || 4000,
        temperature: options.temperature || 0.7,
      },
    });

    return result.response.text();
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

// DeepSeek Provider
export class DeepSeekProvider implements AIProvider {
  name = 'deepseek';
  private client: OpenAI; // DeepSeek uses OpenAI-compatible API

  constructor(apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://api.deepseek.com',
    });
  }

  async generateText(prompt: string, options: any = {}): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: options.model || 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: options.maxTokens || 4000,
      temperature: options.temperature || 0.7,
    });

    return response.choices[0]?.message?.content || '';
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

// Provider Factory
export class AIProviderFactory {
  private providers: Map<string, AIProvider> = new Map();

  addProvider(name: string, provider: AIProvider) {
    this.providers.set(name, provider);
  }

  getProvider(name: string): AIProvider | undefined {
    return this.providers.get(name);
  }

  async generateWithProvider(
    providerName: string,
    prompt: string,
    options: any = {}
  ): Promise<GenerationResult> {
    const provider = this.getProvider(providerName);
    if (!provider) {
      throw new Error(`Provider ${providerName} not found`);
    }

    const startTime = Date.now();
    const content = await provider.generateText(prompt, options);
    const generationTime = (Date.now() - startTime) / 1000;
    const tokensUsed = provider.estimateTokens(content);

    return {
      content,
      tokensUsed,
      model: providerName,
      generationTime,
    };
  }

  getAvailableProviders(): string[] {
    return Array.from(this.providers.keys());
  }
}

// Initialize providers with API keys
export function initializeProviders(): AIProviderFactory {
  const factory = new AIProviderFactory();

  console.log('Initializing AI providers...');
  console.log('OPENAI_API_KEY exists:', !!process.env.OPENAI_API_KEY);
  console.log('OPENAI_API_KEY length:', process.env.OPENAI_API_KEY?.length || 0);
  console.log('ANTHROPIC_API_KEY exists:', !!process.env.ANTHROPIC_API_KEY);
  console.log('GOOGLE_API_KEY exists:', !!process.env.GOOGLE_API_KEY);

  if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'your-openai-api-key-here') {
    console.log('Adding OpenAI provider...');
    factory.addProvider('openai', new OpenAIProvider(process.env.OPENAI_API_KEY));
  } else {
    console.log('OpenAI API key not valid or missing');
  }

  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your-anthropic-api-key-here') {
    console.log('Adding Anthropic provider...');
    factory.addProvider('anthropic', new AnthropicProvider(process.env.ANTHROPIC_API_KEY));
  }

  if (process.env.GOOGLE_API_KEY && process.env.GOOGLE_API_KEY !== 'your-google-api-key-here') {
    console.log('Adding Google provider...');
    factory.addProvider('google', new GoogleProvider(process.env.GOOGLE_API_KEY));
  }

  if (process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY !== 'your-deepseek-api-key-here') {
    console.log('Adding DeepSeek provider...');
    factory.addProvider('deepseek', new DeepSeekProvider(process.env.DEEPSEEK_API_KEY));
  }

  console.log('Available providers:', factory.getAvailableProviders());

  // Warn but don't crash if no providers are available
  // Azure Managed App users configure API keys after deployment via the Settings page
  if (factory.getAvailableProviders().length === 0) {
    console.warn('⚠️  No AI providers configured. Users can add API keys via Settings page.');
  }

  return factory;
}
