import axios from 'axios';

interface GitHubFile {
    path: string;
    content: string;
    message: string;
}

interface GitHubRepo {
    id: number;
    name: string;
    full_name: string;
    private: boolean;
    default_branch: string;
    html_url: string;
}

interface GitHubPushResult {
    success: boolean;
    url?: string;
    sha?: string;
    error?: string;
}

export class GitHubService {
    private token: string;
    private baseUrl = 'https://api.github.com';

    constructor(token: string) {
        this.token = token;
    }

    private getHeaders() {
        return {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/vnd.github.v3+json',
            'X-GitHub-Api-Version': '2022-11-28',
        };
    }

    /**
     * Validate the token and get the authenticated user
     */
    async validateToken(): Promise<{ valid: boolean; username?: string; error?: string }> {
        try {
            const response = await axios.get(`${this.baseUrl}/user`, {
                headers: this.getHeaders(),
            });
            return { valid: true, username: response.data.login };
        } catch (error: any) {
            return {
                valid: false,
                error: error.response?.data?.message || 'Invalid token'
            };
        }
    }

    /**
     * List repositories accessible by the authenticated user
     */
    async listRepos(): Promise<GitHubRepo[]> {
        try {
            const response = await axios.get(`${this.baseUrl}/user/repos`, {
                headers: this.getHeaders(),
                params: {
                    sort: 'updated',
                    per_page: 100,
                    affiliation: 'owner,collaborator',
                },
            });
            return response.data.map((repo: any) => ({
                id: repo.id,
                name: repo.name,
                full_name: repo.full_name,
                private: repo.private,
                default_branch: repo.default_branch,
                html_url: repo.html_url,
            }));
        } catch (error: any) {
            console.error('Error listing repos:', error.response?.data || error.message);
            throw new Error(error.response?.data?.message || 'Failed to list repositories');
        }
    }

    /**
     * Get repository branches
     */
    async listBranches(owner: string, repo: string): Promise<string[]> {
        try {
            const response = await axios.get(
                `${this.baseUrl}/repos/${owner}/${repo}/branches`,
                { headers: this.getHeaders() }
            );
            return response.data.map((branch: any) => branch.name);
        } catch (error: any) {
            console.error('Error listing branches:', error.response?.data || error.message);
            throw new Error(error.response?.data?.message || 'Failed to list branches');
        }
    }

    /**
     * Create or update a file in a repository
     */
    async pushFile(
        owner: string,
        repo: string,
        path: string,
        content: string,
        message: string,
        branch: string = 'main'
    ): Promise<GitHubPushResult> {
        try {
            // First, try to get the file to check if it exists (need SHA for updates)
            let sha: string | undefined;
            try {
                const existingFile = await axios.get(
                    `${this.baseUrl}/repos/${owner}/${repo}/contents/${path}`,
                    {
                        headers: this.getHeaders(),
                        params: { ref: branch }
                    }
                );
                sha = existingFile.data.sha;
            } catch (e) {
                // File doesn't exist, that's okay - we'll create it
            }

            // Create or update the file
            const response = await axios.put(
                `${this.baseUrl}/repos/${owner}/${repo}/contents/${path}`,
                {
                    message,
                    content: Buffer.from(content).toString('base64'),
                    branch,
                    ...(sha ? { sha } : {}),
                },
                { headers: this.getHeaders() }
            );

            return {
                success: true,
                url: response.data.content?.html_url,
                sha: response.data.content?.sha,
            };
        } catch (error: any) {
            console.error('Error pushing file:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.message || 'Failed to push file',
            };
        }
    }

    /**
     * Push multiple files to a repository
     */
    async pushFiles(
        owner: string,
        repo: string,
        files: GitHubFile[],
        branch: string = 'main'
    ): Promise<{ success: boolean; results: GitHubPushResult[] }> {
        const results: GitHubPushResult[] = [];
        let allSuccess = true;

        for (const file of files) {
            const result = await this.pushFile(
                owner,
                repo,
                file.path,
                file.content,
                file.message,
                branch
            );
            results.push(result);
            if (!result.success) {
                allSuccess = false;
            }
        }

        return { success: allSuccess, results };
    }
}

export default GitHubService;
