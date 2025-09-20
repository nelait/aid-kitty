import React, { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/lib/auth-context';
import { chatAPI, apiKeysAPI, chatTemplatesAPI } from '@/lib/api';
import { 
  Send, 
  MessageCircle, 
  Bot, 
  User, 
  Loader2,
  Sparkles,
  Trash2,
  Plus,
  FileText,
  Edit,
  Settings,
  MoreVertical
} from 'lucide-react';

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  provider: string;
  createdAt: string;
  metadata?: string;
}

interface ApiKey {
  id: number;
  provider: string;
  name: string;
  isActive: boolean;
}

interface ChatTemplate {
  id: number;
  name: string;
  description: string;
  content: string;
  category: string;
  tags: string;
  isPublic: boolean;
  usageCount: number;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export default function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [selectedProvider, setSelectedProvider] = useState('');
  const [availableProviders, setAvailableProviders] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(true);
  const [clearingHistory, setClearingHistory] = useState(false);
  
  // Template states
  const [templates, setTemplates] = useState<ChatTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [showCreateTemplate, setShowCreateTemplate] = useState(false);
  const [showEditTemplate, setShowEditTemplate] = useState(false);
  const [showManageTemplates, setShowManageTemplates] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [templateToDelete, setTemplateToDelete] = useState<ChatTemplate | null>(null);
  const [editingTemplate, setEditingTemplate] = useState<ChatTemplate | null>(null);
  const [newTemplate, setNewTemplate] = useState({
    name: '',
    description: '',
    content: '',
    category: 'custom',
    tags: [] as string[],
    isPublic: false
  });
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [updatingTemplate, setUpdatingTemplate] = useState(false);
  const [deletingTemplate, setDeletingTemplate] = useState(false);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const { user } = useAuth();

  useEffect(() => {
    loadMessages();
    loadAvailableProviders();
    loadTemplates();
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const loadMessages = async () => {
    try {
      const chatMessages = await chatAPI.getMessages();
      setMessages(chatMessages);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to load chat messages",
        variant: "destructive",
      });
    } finally {
      setLoadingMessages(false);
    }
  };

  const loadAvailableProviders = async () => {
    try {
      const apiKeys = await apiKeysAPI.getAll();
      const activeKeys = apiKeys.filter((key: ApiKey) => key.isActive);
      setAvailableProviders(activeKeys);
      
      if (activeKeys.length > 0 && !selectedProvider) {
        setSelectedProvider(activeKeys[0].provider);
      }
    } catch (error) {
      console.error('Failed to load API keys:', error);
    }
  };

  const loadTemplates = async () => {
    try {
      const templateList = await chatTemplatesAPI.list();
      setTemplates(templateList);
    } catch (error) {
      console.error('Failed to load templates:', error);
    }
  };

  const handleClearHistory = async () => {
    setClearingHistory(true);
    try {
      await chatAPI.clearHistory();
      setMessages([]);
      toast({
        title: "Success",
        description: "Chat history cleared successfully",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to clear chat history",
        variant: "destructive",
      });
    } finally {
      setClearingHistory(false);
    }
  };

  const handleTemplateSelect = (templateId: string) => {
    if (templateId === 'new') {
      setShowCreateTemplate(true);
      return;
    }
    if (templateId === 'manage') {
      setShowManageTemplates(true);
      return;
    }
    
    const template = templates.find(t => t.id.toString() === templateId);
    if (template) {
      setNewMessage(template.content);
      setSelectedTemplate('');
    }
  };

  const handleCreateTemplate = async () => {
    if (!newTemplate.name || !newTemplate.description || !newTemplate.content) {
      toast({
        title: "Error",
        description: "Please fill in all required fields",
        variant: "destructive",
      });
      return;
    }

    setCreatingTemplate(true);
    try {
      await chatTemplatesAPI.create(newTemplate);
      setShowCreateTemplate(false);
      setNewTemplate({
        name: '',
        description: '',
        content: '',
        category: 'custom',
        tags: [],
        isPublic: false
      });
      loadTemplates();
      toast({
        title: "Success",
        description: "Template created successfully",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to create template",
        variant: "destructive",
      });
    } finally {
      setCreatingTemplate(false);
    }
  };

  const handleEditTemplate = (template: ChatTemplate) => {
    setEditingTemplate(template);
    setNewTemplate({
      name: template.name,
      description: template.description,
      content: template.content,
      category: template.category,
      tags: template.tags ? JSON.parse(template.tags) : [],
      isPublic: template.isPublic
    });
    setShowEditTemplate(true);
    setShowManageTemplates(false);
  };

  const handleUpdateTemplate = async () => {
    if (!editingTemplate || !newTemplate.name || !newTemplate.description || !newTemplate.content) {
      toast({
        title: "Error",
        description: "Please fill in all required fields",
        variant: "destructive",
      });
      return;
    }

    setUpdatingTemplate(true);
    try {
      await chatTemplatesAPI.update(editingTemplate.id, newTemplate);
      setShowEditTemplate(false);
      setEditingTemplate(null);
      setNewTemplate({
        name: '',
        description: '',
        content: '',
        category: 'custom',
        tags: [],
        isPublic: false
      });
      loadTemplates();
      toast({
        title: "Success",
        description: "Template updated successfully",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update template",
        variant: "destructive",
      });
    } finally {
      setUpdatingTemplate(false);
    }
  };

  const handleDeleteTemplate = (template: ChatTemplate) => {
    setTemplateToDelete(template);
    setShowDeleteConfirm(true);
    setShowManageTemplates(false);
  };

  const confirmDeleteTemplate = async () => {
    if (!templateToDelete) return;

    setDeletingTemplate(true);
    try {
      await chatTemplatesAPI.delete(templateToDelete.id);
      setShowDeleteConfirm(false);
      setTemplateToDelete(null);
      loadTemplates();
      toast({
        title: "Success",
        description: "Template deleted successfully",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to delete template",
        variant: "destructive",
      });
    } finally {
      setDeletingTemplate(false);
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!newMessage.trim() || !selectedProvider) {
      toast({
        title: "Error",
        description: "Please enter a message and select an AI provider",
        variant: "destructive",
      });
      return;
    }

    setLoading(true);
    
    try {
      const response = await chatAPI.sendMessage({
        content: newMessage,
        provider: selectedProvider,
      });

      setMessages(prev => [...prev, response.userMessage, response.aiMessage]);
      setNewMessage('');
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to send message",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage(e);
    }
  };

  const getProviderLabel = (provider: string) => {
    const labels: Record<string, string> = {
      openai: 'OpenAI',
      anthropic: 'Anthropic',
      google: 'Google',
      deepseek: 'DeepSeek',
    };
    return labels[provider] || provider;
  };

  const getCategoryColor = (category: string) => {
    const colors: Record<string, string> = {
      coaching: 'bg-blue-100 text-blue-800',
      brainstorming: 'bg-purple-100 text-purple-800',
      technical: 'bg-green-100 text-green-800',
      business: 'bg-orange-100 text-orange-800',
      analysis: 'bg-red-100 text-red-800',
      custom: 'bg-gray-100 text-gray-800',
    };
    return colors[category] || colors.custom;
  };

  const formatTime = (dateString: string) => {
    return new Date(dateString).toLocaleTimeString([], { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
  };

  const canEditTemplate = (template: ChatTemplate) => {
    return template.userId === user?.id || template.userId === 'system';
  };

  if (loadingMessages) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-4">
      <Card className="h-[80vh] flex flex-col">
        <CardHeader className="border-b flex-shrink-0">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5" />
              AI Chat
            </CardTitle>
            
            {messages.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleClearHistory}
                disabled={clearingHistory}
                className="text-red-600 hover:text-red-700 hover:bg-red-50"
              >
                {clearingHistory ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                Clear History
              </Button>
            )}
          </div>
          
          <div className="flex items-center gap-4">
            {availableProviders.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">AI Provider:</span>
                <Select value={selectedProvider} onValueChange={setSelectedProvider}>
                  <SelectTrigger className="w-40">
                    <SelectValue placeholder="Select provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableProviders.map((apiKey) => (
                      <SelectItem key={apiKey.id} value={apiKey.provider}>
                        {getProviderLabel(apiKey.provider)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            
            {templates.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Template:</span>
                <Select value={selectedTemplate} onValueChange={handleTemplateSelect}>
                  <SelectTrigger className="w-48">
                    <SelectValue placeholder="Choose template" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="new">
                      <div className="flex items-center gap-2">
                        <Plus className="h-4 w-4" />
                        Create New Template
                      </div>
                    </SelectItem>
                    <SelectItem value="manage">
                      <div className="flex items-center gap-2">
                        <Settings className="h-4 w-4" />
                        Manage Templates
                      </div>
                    </SelectItem>
                    {templates.map((template) => (
                      <SelectItem key={template.id} value={template.id.toString()}>
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4" />
                          <span>{template.name}</span>
                          <Badge className={getCategoryColor(template.category)}>
                            {template.category}
                          </Badge>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </CardHeader>

        <CardContent className="flex-1 flex flex-col p-0 min-h-0">
          {/* Messages Area - Fixed height with internal scrolling */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <Sparkles className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium mb-2">Start a conversation</h3>
                <p className="text-muted-foreground">
                  Ask questions about MVP development, get advice, or brainstorm ideas
                </p>
                {templates.length > 0 && (
                  <p className="text-sm text-muted-foreground mt-2">
                    Use templates above to get started with structured prompts
                  </p>
                )}
              </div>
            ) : (
              messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex gap-3 ${
                    message.role === 'user' ? 'justify-end' : 'justify-start'
                  }`}
                >
                  {message.role === 'assistant' && (
                    <div className="flex-shrink-0">
                      <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center">
                        <Bot className="h-4 w-4 text-blue-600" />
                      </div>
                    </div>
                  )}
                  
                  <div
                    className={`max-w-[70%] rounded-lg px-4 py-2 ${
                      message.role === 'user'
                        ? 'bg-blue-600 text-white'
                        : 'bg-muted'
                    }`}
                  >
                    <div className="whitespace-pre-wrap">{message.content}</div>
                    <div className={`text-xs mt-1 ${
                      message.role === 'user' ? 'text-blue-100' : 'text-muted-foreground'
                    }`}>
                      {formatTime(message.createdAt)} • {getProviderLabel(message.provider)}
                    </div>
                  </div>

                  {message.role === 'user' && (
                    <div className="flex-shrink-0">
                      <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center">
                        <User className="h-4 w-4 text-gray-600" />
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}
            
            {loading && (
              <div className="flex gap-3 justify-start">
                <div className="flex-shrink-0">
                  <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center">
                    <Bot className="h-4 w-4 text-blue-600" />
                  </div>
                </div>
                <div className="bg-muted rounded-lg px-4 py-2">
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span className="text-sm text-muted-foreground">Thinking...</span>
                  </div>
                </div>
              </div>
            )}
            
            <div ref={messagesEndRef} />
          </div>

          {/* Input Area - Fixed at bottom */}
          <div className="border-t p-4 flex-shrink-0">
            {availableProviders.length === 0 ? (
              <div className="text-center p-4 bg-muted rounded-lg">
                <p className="text-muted-foreground mb-2">
                  No AI providers configured. Add an API key to start chatting.
                </p>
                <Button variant="outline" onClick={() => window.location.href = '/settings'}>
                  Add API Key
                </Button>
              </div>
            ) : (
              <form onSubmit={handleSendMessage} className="space-y-2">
                <Textarea
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask anything about MVP development... (Enter to send, Shift+Enter for new line)"
                  disabled={loading}
                  className="min-h-[60px] resize-none"
                />
                <div className="flex justify-end">
                  <Button type="submit" disabled={loading || !newMessage.trim()}>
                    {loading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                    Send
                  </Button>
                </div>
              </form>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Create Template Dialog */}
      <Dialog open={showCreateTemplate} onOpenChange={setShowCreateTemplate}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create New Chat Template</DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Name *</label>
              <Input
                value={newTemplate.name}
                onChange={(e) => setNewTemplate(prev => ({ ...prev, name: e.target.value }))}
                placeholder="Template name"
              />
            </div>
            
            <div>
              <label className="text-sm font-medium">Description *</label>
              <Input
                value={newTemplate.description}
                onChange={(e) => setNewTemplate(prev => ({ ...prev, description: e.target.value }))}
                placeholder="Brief description of what this template does"
              />
            </div>
            
            <div>
              <label className="text-sm font-medium">Category</label>
              <Select 
                value={newTemplate.category} 
                onValueChange={(value) => setNewTemplate(prev => ({ ...prev, category: value }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="coaching">Coaching</SelectItem>
                  <SelectItem value="brainstorming">Brainstorming</SelectItem>
                  <SelectItem value="technical">Technical</SelectItem>
                  <SelectItem value="business">Business</SelectItem>
                  <SelectItem value="analysis">Analysis</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            <div>
              <label className="text-sm font-medium">Template Content *</label>
              <Textarea
                value={newTemplate.content}
                onChange={(e) => setNewTemplate(prev => ({ ...prev, content: e.target.value }))}
                placeholder="Enter your template prompt here..."
                className="min-h-[120px]"
              />
            </div>
            
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="isPublic"
                checked={newTemplate.isPublic}
                onChange={(e) => setNewTemplate(prev => ({ ...prev, isPublic: e.target.checked }))}
              />
              <label htmlFor="isPublic" className="text-sm">Make this template public</label>
            </div>
            
            <div className="flex justify-end gap-2">
              <Button 
                variant="outline" 
                onClick={() => setShowCreateTemplate(false)}
                disabled={creatingTemplate}
              >
                Cancel
              </Button>
              <Button onClick={handleCreateTemplate} disabled={creatingTemplate}>
                {creatingTemplate ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Creating...
                  </>
                ) : (
                  'Create Template'
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Template Dialog */}
      <Dialog open={showEditTemplate} onOpenChange={setShowEditTemplate}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Template</DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Name *</label>
              <Input
                value={newTemplate.name}
                onChange={(e) => setNewTemplate(prev => ({ ...prev, name: e.target.value }))}
                placeholder="Template name"
              />
            </div>
            
            <div>
              <label className="text-sm font-medium">Description *</label>
              <Input
                value={newTemplate.description}
                onChange={(e) => setNewTemplate(prev => ({ ...prev, description: e.target.value }))}
                placeholder="Brief description of what this template does"
              />
            </div>
            
            <div>
              <label className="text-sm font-medium">Category</label>
              <Select 
                value={newTemplate.category} 
                onValueChange={(value) => setNewTemplate(prev => ({ ...prev, category: value }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="coaching">Coaching</SelectItem>
                  <SelectItem value="brainstorming">Brainstorming</SelectItem>
                  <SelectItem value="technical">Technical</SelectItem>
                  <SelectItem value="business">Business</SelectItem>
                  <SelectItem value="analysis">Analysis</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            <div>
              <label className="text-sm font-medium">Template Content *</label>
              <Textarea
                value={newTemplate.content}
                onChange={(e) => setNewTemplate(prev => ({ ...prev, content: e.target.value }))}
                placeholder="Enter your template prompt here..."
                className="min-h-[120px]"
              />
            </div>
            
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="isPublicEdit"
                checked={newTemplate.isPublic}
                onChange={(e) => setNewTemplate(prev => ({ ...prev, isPublic: e.target.checked }))}
              />
              <label htmlFor="isPublicEdit" className="text-sm">Make this template public</label>
            </div>
            
            <div className="flex justify-end gap-2">
              <Button 
                variant="outline" 
                onClick={() => setShowEditTemplate(false)}
                disabled={updatingTemplate}
              >
                Cancel
              </Button>
              <Button onClick={handleUpdateTemplate} disabled={updatingTemplate}>
                {updatingTemplate ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Updating...
                  </>
                ) : (
                  'Update Template'
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Manage Templates Dialog */}
      <Dialog open={showManageTemplates} onOpenChange={setShowManageTemplates}>
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Manage Templates</DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4">
            {templates.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No templates found</p>
            ) : (
              <div className="grid gap-4">
                {templates.map((template) => (
                  <div key={template.id} className="border rounded-lg p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2">
                          <h3 className="font-medium">{template.name}</h3>
                          <Badge className={getCategoryColor(template.category)}>
                            {template.category}
                          </Badge>
                          {template.isPublic && (
                            <Badge variant="outline">Public</Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground mb-2">
                          {template.description}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Used {template.usageCount} times • Created {new Date(template.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                      
                      {canEditTemplate(template) && (
                        <div className="flex gap-2 ml-4">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleEditTemplate(template)}
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleDeleteTemplate(template)}
                            className="text-red-600 hover:text-red-700"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      )}
                    </div>
                    
                    <div className="mt-3 p-3 bg-muted rounded text-sm">
                      <div className="line-clamp-3">{template.content}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Template</DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4">
            <p>Are you sure you want to delete "{templateToDelete?.name}"?</p>
            <p className="text-sm text-muted-foreground">This action cannot be undone.</p>
            
            <div className="flex justify-end gap-2">
              <Button 
                variant="outline" 
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deletingTemplate}
              >
                Cancel
              </Button>
              <Button 
                variant="destructive"
                onClick={confirmDeleteTemplate} 
                disabled={deletingTemplate}
              >
                {deletingTemplate ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Deleting...
                  </>
                ) : (
                  'Delete Template'
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
