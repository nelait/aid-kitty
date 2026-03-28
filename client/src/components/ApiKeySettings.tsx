import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/lib/auth-context';
import { apiKeysAPI, githubAPI } from '@/lib/api';
import {
  Key,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Settings,
  CheckCircle,
  XCircle,
  GitBranch,
  Loader2,
  Link,
  Unlink
} from 'lucide-react';

interface ApiKey {
  id: number;
  provider: string;
  name: string;
  key: string;
  isActive: boolean;
  createdAt: string;
}

const PROVIDERS = [
  { value: 'openai', label: 'OpenAI', description: 'GPT-4, GPT-3.5 models' },
  { value: 'anthropic', label: 'Anthropic', description: 'Claude models' },
  { value: 'google', label: 'Google', description: 'Gemini models' },
  { value: 'deepseek', label: 'DeepSeek', description: 'DeepSeek Chat models' },
];

export default function ApiKeySettings() {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [visibleKeys, setVisibleKeys] = useState<Set<number>>(new Set());
  const { toast } = useToast();
  const { user } = useAuth();

  const [newKey, setNewKey] = useState({
    provider: '',
    name: '',
    key: '',
  });

  // GitHub state
  const [githubConnected, setGithubConnected] = useState(false);
  const [githubUsername, setGithubUsername] = useState('');
  const [githubPat, setGithubPat] = useState('');
  const [isConnectingGithub, setIsConnectingGithub] = useState(false);
  const [githubLoading, setGithubLoading] = useState(true);

  useEffect(() => {
    loadApiKeys();
    loadGithubSettings();
  }, []);

  const loadApiKeys = async () => {
    try {
      const keys = await apiKeysAPI.getAll();
      setApiKeys(keys);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to load API keys",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleAddKey = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!newKey.provider || !newKey.key) {
      toast({
        title: "Error",
        description: "Please fill in all required fields",
        variant: "destructive",
      });
      return;
    }

    try {
      await apiKeysAPI.create(newKey);
      toast({
        title: "Success",
        description: "API key added successfully",
      });

      setNewKey({ provider: '', name: '', key: '' });
      setShowAddForm(false);
      loadApiKeys();
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to add API key",
        variant: "destructive",
      });
    }
  };

  const handleDeleteKey = async (id: number) => {
    try {
      await apiKeysAPI.delete(id);
      toast({
        title: "Success",
        description: "API key deleted successfully",
      });
      loadApiKeys();
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to delete API key",
        variant: "destructive",
      });
    }
  };

  const toggleKeyVisibility = (id: number) => {
    const newVisible = new Set(visibleKeys);
    if (newVisible.has(id)) {
      newVisible.delete(id);
    } else {
      newVisible.add(id);
    }
    setVisibleKeys(newVisible);
  };

  const maskApiKey = (key: string) => {
    if (key.length <= 8) return '***';
    return key.substring(0, 4) + '***' + key.substring(key.length - 4);
  };

  const getProviderLabel = (provider: string) => {
    return PROVIDERS.find(p => p.value === provider)?.label || provider;
  };

  // GitHub functions
  const loadGithubSettings = async () => {
    try {
      const response = await githubAPI.getSettings();
      setGithubConnected(response.connected);
      if (response.settings?.username) {
        setGithubUsername(response.settings.username);
      }
    } catch (error) {
      console.error('Error loading GitHub settings:', error);
    } finally {
      setGithubLoading(false);
    }
  };

  const connectGithub = async () => {
    if (!githubPat.trim()) {
      toast({
        title: "Error",
        description: "Please enter your GitHub Personal Access Token",
        variant: "destructive",
      });
      return;
    }

    setIsConnectingGithub(true);
    try {
      const result = await githubAPI.connect(githubPat);
      setGithubConnected(true);
      setGithubUsername(result.username);
      setGithubPat('');
      toast({
        title: "Success",
        description: `Connected to GitHub as ${result.username}`,
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.response?.data?.error || "Failed to connect to GitHub",
        variant: "destructive",
      });
    } finally {
      setIsConnectingGithub(false);
    }
  };

  const disconnectGithub = async () => {
    try {
      await githubAPI.disconnect();
      setGithubConnected(false);
      setGithubUsername('');
      toast({
        title: "Success",
        description: "Disconnected from GitHub",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to disconnect from GitHub",
        variant: "destructive",
      });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Settings className="h-6 w-6" />
            API Key Management
          </h2>
          <p className="text-muted-foreground">
            Manage your AI provider API keys for MVP generation
          </p>
        </div>
        <Button onClick={() => setShowAddForm(true)} className="flex items-center gap-2">
          <Plus className="h-4 w-4" />
          Add API Key
        </Button>
      </div>

      {/* Add API Key Form */}
      {showAddForm && (
        <Card>
          <CardHeader>
            <CardTitle>Add New API Key</CardTitle>
            <CardDescription>
              Add an API key for one of the supported AI providers
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleAddKey} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="provider">Provider *</Label>
                  <Select value={newKey.provider} onValueChange={(value) => setNewKey({ ...newKey, provider: value })}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select provider" />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVIDERS.map((provider) => (
                        <SelectItem key={provider.value} value={provider.value}>
                          <div>
                            <div className="font-medium">{provider.label}</div>
                            <div className="text-sm text-muted-foreground">{provider.description}</div>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="name">Name (Optional)</Label>
                  <Input
                    id="name"
                    placeholder="e.g., My OpenAI Key"
                    value={newKey.name}
                    onChange={(e) => setNewKey({ ...newKey, name: e.target.value })}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="key">API Key *</Label>
                <Input
                  id="key"
                  type="password"
                  placeholder="Enter your API key"
                  value={newKey.key}
                  onChange={(e) => setNewKey({ ...newKey, key: e.target.value })}
                />
              </div>

              <div className="flex gap-2">
                <Button type="submit">Add Key</Button>
                <Button type="button" variant="outline" onClick={() => setShowAddForm(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* API Keys List */}
      <div className="space-y-4">
        {apiKeys.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-8">
              <Key className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">No API Keys</h3>
              <p className="text-muted-foreground text-center mb-4">
                Add your first API key to start generating MVP plans with AI
              </p>
              <Button onClick={() => setShowAddForm(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Add API Key
              </Button>
            </CardContent>
          </Card>
        ) : (
          apiKeys.map((apiKey) => (
            <Card key={apiKey.id}>
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      {apiKey.isActive ? (
                        <CheckCircle className="h-5 w-5 text-green-500" />
                      ) : (
                        <XCircle className="h-5 w-5 text-red-500" />
                      )}
                      <div>
                        <h3 className="font-medium">
                          {apiKey.name || `${getProviderLabel(apiKey.provider)} Key`}
                        </h3>
                        <p className="text-sm text-muted-foreground">
                          {getProviderLabel(apiKey.provider)} • Added {new Date(apiKey.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-2 bg-muted px-3 py-1 rounded">
                      <Key className="h-4 w-4" />
                      <span className="font-mono text-sm">
                        {visibleKeys.has(apiKey.id) ? apiKey.key : maskApiKey(apiKey.key)}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => toggleKeyVisibility(apiKey.id)}
                      >
                        {visibleKeys.has(apiKey.id) ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </Button>
                    </div>

                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteKey(apiKey.id)}
                      className="text-red-600 hover:text-red-700"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* GitHub Integration */}
      <div className="mt-10">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-2xl font-bold flex items-center gap-2">
              <GitBranch className="h-6 w-6" />
              GitHub Integration
            </h2>
            <p className="text-muted-foreground">
              Connect your GitHub account to push generated documents to repositories
            </p>
          </div>
        </div>

        <Card>
          <CardContent className="p-6">
            {githubLoading ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            ) : githubConnected ? (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <CheckCircle className="h-5 w-5 text-green-500" />
                  <div>
                    <p className="font-medium">Connected to GitHub</p>
                    <p className="text-sm text-muted-foreground">@{githubUsername}</p>
                  </div>
                </div>
                <Button variant="outline" onClick={disconnectGithub} className="flex items-center gap-2">
                  <Unlink className="h-4 w-4" />
                  Disconnect
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <p className="text-sm text-muted-foreground mb-4">
                    Enter your GitHub Personal Access Token to enable pushing documents to your repositories.
                    The token requires <strong>repo</strong> scope.
                  </p>
                  <div className="flex gap-2">
                    <Input
                      type="password"
                      placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                      value={githubPat}
                      onChange={(e) => setGithubPat(e.target.value)}
                      className="flex-1"
                    />
                    <Button onClick={connectGithub} disabled={isConnectingGithub} className="flex items-center gap-2">
                      {isConnectingGithub ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Connecting...
                        </>
                      ) : (
                        <>
                          <Link className="h-4 w-4" />
                          Connect GitHub
                        </>
                      )}
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  <a
                    href="https://github.com/settings/tokens/new?scopes=repo&description=AID%20Kitty%20MVP%20Generator"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    Generate a new token on GitHub →
                  </a>
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
