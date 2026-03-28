/**
 * OpenHands Cloud API Service
 * 
 * Integrates with OpenHands Cloud (https://app.all-hands.dev) to trigger
 * AI agent builds from generated prompts.
 */

const OPENHANDS_API_BASE = 'https://app.all-hands.dev/api';

export interface OpenHandsConversation {
    status: string;
    conversation_id: string;
}

export interface OpenHandsConversationStatus {
    conversation_id: string;
    status: string;
    runtime_status?: string;
    title?: string;
    created_at?: string;
    updated_at?: string;
    last_updated_at?: string;
}

export class OpenHandsService {
    private apiKey: string;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    /**
     * Parse a repository input into owner/repo format.
     * Accepts: "owner/repo", "https://github.com/owner/repo", "https://github.com/owner/repo.git"
     */
    static parseRepository(input: string): string {
        let repo = input.trim();

        // Remove trailing .git
        if (repo.endsWith('.git')) {
            repo = repo.slice(0, -4);
        }

        // Handle full GitHub URLs
        const urlMatch = repo.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+\/[^/]+)/);
        if (urlMatch) {
            return urlMatch[1];
        }

        // Already in owner/repo format
        if (repo.includes('/') && !repo.includes(':') && !repo.includes('//')) {
            return repo;
        }

        return repo;
    }

    /**
     * Start a new conversation with the OpenHands agent.
     * The agent will read the prompt and start building in the specified repo.
     */
    async startConversation(prompt: string, repository: string): Promise<OpenHandsConversation> {
        // Normalize repository format
        const normalizedRepo = OpenHandsService.parseRepository(repository);

        const response = await fetch(`${OPENHANDS_API_BASE}/conversations`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                initial_user_msg: prompt,
                repository: normalizedRepo,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            if (response.status === 401) {
                throw new Error('Invalid or expired OpenHands API key. Please check your API key in settings.');
            }
            if (response.status === 403) {
                throw new Error(`OpenHands does not have access to repo "${normalizedRepo}". Make sure the repo exists and your OpenHands account is linked to GitHub.`);
            }
            if (response.status === 404) {
                throw new Error(`Repository "${normalizedRepo}" not found. Make sure it exists on GitHub in owner/repo format.`);
            }
            throw new Error(`OpenHands API error (${response.status}): ${errorText}`);
        }

        return response.json();
    }

    /**
     * Get the status of an existing conversation.
     */
    async getConversationStatus(conversationId: string): Promise<OpenHandsConversationStatus> {
        const response = await fetch(`${OPENHANDS_API_BASE}/conversations/${conversationId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`OpenHands API error (${response.status}): ${errorText}`);
        }

        return response.json();
    }

    /**
     * Validate the API key by making a lightweight request.
     */
    async validateApiKey(): Promise<{ valid: boolean; error?: string }> {
        try {
            // Try listing conversations as a validation check
            const response = await fetch(`${OPENHANDS_API_BASE}/conversations`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                },
            });

            if (response.ok || response.status === 200) {
                return { valid: true };
            }

            if (response.status === 401 || response.status === 403) {
                return { valid: false, error: 'Invalid or expired API key' };
            }

            return { valid: true }; // Other status codes likely mean the key is valid
        } catch (error: any) {
            return { valid: false, error: error.message || 'Failed to connect to OpenHands Cloud' };
        }
    }

    /**
     * Get the conversation URL for the OpenHands Cloud dashboard.
     */
    static getConversationUrl(conversationId: string): string {
        return `https://app.all-hands.dev/conversations/${conversationId}`;
    }
}
