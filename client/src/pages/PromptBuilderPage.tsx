import React, { useState, useEffect, useRef } from 'react';
import {
  Search,
  Filter,
  Plus,
  Copy,
  Download,
  Trash2,
  Edit,
  Eye,
  FileText,
  Zap,
  Clock,
  Tag,
  Settings,
  X,
  GitBranch,
  Save,
  Check,
  Loader2,
  Paperclip,
  FolderOpen,
  Rocket,
  ExternalLink
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card } from '../components/ui/card';
import { useToast } from '../hooks/use-toast';
import { githubAPI, promptSessionsAPI, projectsAPI, documentsAPI, openhandsAPI } from '../lib/api';

interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  applicationType: string;
  category: string;
  tags: string[];
  guidelines: any;
  standards: any;
  libraries: any;
  architecture: any;
  security: any;
  performance: any;
  testing: any;
  deployment: any;
  precautions: any;
  customSections: any[];
  createdAt: string;
  updatedAt: string;
  userId: string;
}

interface PromptSession {
  id: string;
  templateId: string;
  projectDescription: string;
  selectedFeatures: string[];
  customRequirements: string[];
  generatedPrompt: string;
  createdAt: string;
  template?: {
    id: string;
    name: string;
    applicationType: string;
    category: string;
  };
}

interface Metadata {
  applicationTypes: string[];
  categories: string[];
  priorities: string[];
  impacts: string[];
  severities: string[];
}

const PromptBuilderPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'templates' | 'sessions' | 'generate' | 'build'>('templates');
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [sessions, setSessions] = useState<PromptSession[]>([]);
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [projectDescription, setProjectDescription] = useState('');
  const [selectedFeatures, setSelectedFeatures] = useState<string[]>([]);
  const [customRequirements, setCustomRequirements] = useState<string[]>(['']);
  const [generatedPrompt, setGeneratedPrompt] = useState('');
  const [viewingSession, setViewingSession] = useState<PromptSession | null>(null);
  const [viewingTemplate, setViewingTemplate] = useState<PromptTemplate | null>(null);
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<PromptTemplate | null>(null);

  // Session selection & edit state
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set());
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [editedPromptText, setEditedPromptText] = useState('');
  const [savingPrompt, setSavingPrompt] = useState(false);

  // Template selection state
  const [selectedTemplates, setSelectedTemplates] = useState<Set<string>>(new Set());

  // Document attachment state (for generate tab)
  const [projects, setProjects] = useState<any[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>('');
  const [projectDocuments, setProjectDocuments] = useState<any[]>([]);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<Set<string>>(new Set());
  const [docsPath, setDocsPath] = useState<string>('docs');

  // GitHub push state
  const [showGitHubModal, setShowGitHubModal] = useState(false);
  const [gitHubPushType, setGitHubPushType] = useState<'sessions' | 'templates'>('sessions');
  const [repos, setRepos] = useState<any[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedRepo, setSelectedRepo] = useState('');
  const [selectedBranch, setSelectedBranch] = useState('main');
  const [pushPath, setPushPath] = useState('prompts');
  const [pushing, setPushing] = useState(false);

  // OpenHands build state
  const [openhandsConnected, setOpenhandsConnected] = useState(false);
  const [openhandsRepo, setOpenhandsRepo] = useState('');
  const [openhandsBuildInfo, setOpenhandsBuildInfo] = useState<{
    id: string;
    conversationId: string;
    conversationUrl: string;
    status: string;
    repository: string;
  } | null>(null);
  const [openhandsBuilding, setOpenhandsBuilding] = useState(false);
  const [showBuildPanel, setShowBuildPanel] = useState(false);
  const [openhandsApiKey, setOpenhandsApiKey] = useState('');
  const [savingOpenhandsSettings, setSavingOpenhandsSettings] = useState(false);
  const [buildsList, setBuildsList] = useState<any[]>([]);
  const [selectedBuildPrompt, setSelectedBuildPrompt] = useState('');
  const [viewingConversationUrl, setViewingConversationUrl] = useState<string | null>(null);
  const [iframeError, setIframeError] = useState(false);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [showOpenhandsSettings, setShowOpenhandsSettings] = useState(false);

  const [newTemplate, setNewTemplate] = useState({
    name: '',
    description: '',
    applicationType: '',
    category: '',
    tags: [] as string[],
    guidelines: {
      architecture: [] as string[],
      structure: [] as string[],
      performance: [] as string[]
    },
    standards: {
      naming: [] as string[],
      formatting: [] as string[],
      documentation: [] as string[]
    },
    libraries: {
      core: [] as string[],
      ui: [] as string[],
      utilities: [] as string[]
    },
    architecture: {
      patterns: [] as string[],
      dataFlow: [] as string[],
      routing: [] as string[]
    },
    security: {
      authentication: '',
      dataProtection: '',
      dependencies: ''
    },
    performance: {
      optimization: '',
      monitoring: '',
      loading: ''
    },
    testing: {
      unit: '',
      integration: '',
      e2e: ''
    },
    deployment: {
      build: '',
      hosting: '',
      cicd: ''
    },
    precautions: {
      common_issues: '',
      performance_pitfalls: '',
      security_risks: ''
    },
    customSections: [] as any[],
  });

  const { toast } = useToast();

  useEffect(() => {
    fetchTemplates();
    fetchSessions();
    fetchMetadata();
    // Fetch projects for the document attachment feature
    const fetchProjects = async () => {
      try {
        const res = await projectsAPI.list();
        setProjects(res.data || []);
      } catch (e) {
        console.error('Failed to fetch projects:', e);
      }
    };
    fetchProjects();
  }, []);

  // Fetch documents when a project is selected
  useEffect(() => {
    if (!selectedProject) {
      setProjectDocuments([]);
      setSelectedDocumentIds(new Set());
      return;
    }
    const fetchDocs = async () => {
      try {
        const res = await documentsAPI.getProjectDocuments(selectedProject);
        setProjectDocuments(res.documents || []);
        // Select all documents by default
        setSelectedDocumentIds(new Set((res.documents || []).map((d: any) => d.id)));
      } catch (e) {
        console.error('Failed to fetch project documents:', e);
        setProjectDocuments([]);
      }
    };
    fetchDocs();
  }, [selectedProject]);

  // Check OpenHands connection status on mount
  useEffect(() => {
    const checkOpenhands = async () => {
      try {
        const res = await openhandsAPI.getSettings();
        setOpenhandsConnected(res.connected);
        if (res.settings?.defaultRepo) {
          setOpenhandsRepo(res.settings.defaultRepo);
        }
      } catch (e) {
        // Not connected
      }
    };
    checkOpenhands();
  }, []);

  // OpenHands build function
  // Cleanup poll interval on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  // Fetch builds list when build tab is active
  useEffect(() => {
    if (activeTab === 'build') {
      const fetchBuilds = async () => {
        try {
          const res = await openhandsAPI.listBuilds();
          setBuildsList(res.builds || []);
        } catch (e) {
          console.error('Failed to fetch builds:', e);
        }
      };
      fetchBuilds();
    }
  }, [activeTab]);

  const startOpenhandsBuild = async () => {
    const promptToUse = selectedBuildPrompt || generatedPrompt;
    if (!promptToUse || !openhandsRepo) {
      toast({
        title: 'Missing Information',
        description: !promptToUse ? 'Select a prompt to build with' : 'Enter a target repository (owner/repo)',
        variant: 'destructive',
      });
      return;
    }

    setOpenhandsBuilding(true);
    // Clear previous poll
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }

    try {
      const result = await openhandsAPI.startBuild({
        prompt: promptToUse,
        repository: openhandsRepo,
        sessionId: viewingSession?.id,
      });

      setOpenhandsBuildInfo(result.build);
      setViewingConversationUrl(result.build.conversationUrl);
      toast({
        title: '🚀 Build Started!',
        description: `OpenHands agent is building in ${openhandsRepo}`,
      });

      // Refresh builds list
      try {
        const res = await openhandsAPI.listBuilds();
        setBuildsList(res.builds || []);
      } catch (e) { /* ignore */ }

      // Start polling status with useRef
      pollIntervalRef.current = setInterval(async () => {
        try {
          console.log('[Poll] Checking build status for:', result.build.id);
          const statusRes = await openhandsAPI.getBuildStatus(result.build.id);
          console.log('[Poll] Raw response:', JSON.stringify(statusRes));
          const newStatus = statusRes.build?.status || statusRes.liveStatus?.status || 'running';
          console.log('[Poll] Mapped status:', newStatus);
          setOpenhandsBuildInfo(prev => prev ? {
            ...prev,
            status: newStatus,
          } : null);
          if (['completed', 'failed'].includes(newStatus)) {
            console.log('[Poll] Terminal status reached, stopping poll');
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
            // Refresh builds list
            try {
              const res = await openhandsAPI.listBuilds();
              setBuildsList(res.builds || []);
            } catch (e) { /* ignore */ }
          }
        } catch (e) {
          console.error('[Poll] Polling error:', e);
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
        }
      }, 10000);

    } catch (error: any) {
      toast({
        title: 'Build Failed',
        description: error.response?.data?.error || error.message || 'Failed to start OpenHands build',
        variant: 'destructive',
      });
    } finally {
      setOpenhandsBuilding(false);
    }
  };

  useEffect(() => {
    if (editingTemplate) {
      const convertedTemplate = convertDbFormatToForm(editingTemplate);
      setNewTemplate(convertedTemplate);
    } else {
      // Reset to default when not editing
      resetNewTemplate();
    }
  }, [editingTemplate]);

  const resetNewTemplate = () => {
    setNewTemplate({
      name: '',
      description: '',
      applicationType: '',
      category: '',
      tags: [] as string[],
      guidelines: {
        architecture: [] as string[],
        structure: [] as string[],
        performance: [] as string[]
      },
      standards: {
        naming: [] as string[],
        formatting: [] as string[],
        documentation: [] as string[]
      },
      libraries: {
        core: [] as string[],
        ui: [] as string[],
        utilities: [] as string[]
      },
      architecture: {
        patterns: [] as string[],
        dataFlow: [] as string[],
        routing: [] as string[]
      },
      security: {
        authentication: '',
        dataProtection: '',
        dependencies: ''
      },
      performance: {
        optimization: '',
        monitoring: '',
        loading: ''
      },
      testing: {
        unit: '',
        integration: '',
        e2e: ''
      },
      deployment: {
        build: '',
        hosting: '',
        cicd: ''
      },
      precautions: {
        common_issues: '',
        performance_pitfalls: '',
        security_risks: ''
      },
      customSections: [] as any[],
    });
  };

  const fetchTemplates = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/prompt-builder/templates', {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setTemplates(data.templates || []);
      } else {
        const error = await response.json();
        toast({ title: error.error || 'Failed to fetch templates', variant: 'destructive' });
      }
    } catch (error) {
      toast({ title: 'Failed to fetch templates', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const fetchSessions = async () => {
    try {
      const response = await fetch('/api/prompt-builder/sessions', {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setSessions(data.sessions || []);
      }
    } catch (error) {
      toast({ title: 'Failed to fetch sessions', variant: 'destructive' });
    }
  };

  const fetchMetadata = async () => {
    try {
      const response = await fetch('/api/prompt-builder/metadata', {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setMetadata(data);
      }
    } catch (error) {
      // Ignore error
    }
  };

  const generatePrompt = async () => {
    if (!selectedTemplate || !projectDescription.trim()) {
      toast({ title: 'Please select a template and enter project description', variant: 'destructive' });
      return;
    }

    try {
      setLoading(true);
      const response = await fetch('/api/prompt-builder/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({
          templateId: selectedTemplate,
          projectDescription,
          selectedFeatures: selectedFeatures.filter(f => f.trim()),
          customRequirements: customRequirements.filter(r => r.trim()),
          ...(selectedProject && selectedDocumentIds.size > 0 ? {
            projectId: selectedProject,
            selectedDocumentIds: Array.from(selectedDocumentIds),
            docsPath
          } : {})
        })
      });

      if (response.ok) {
        const data = await response.json();
        setGeneratedPrompt(data.prompt);
        toast({ title: 'Prompt generated successfully!', variant: 'success' });
        fetchSessions(); // Refresh sessions list
      } else {
        const error = await response.json();
        toast({ title: error.error || 'Failed to generate prompt', variant: 'destructive' });
      }
    } catch (error) {
      toast({ title: 'Failed to generate prompt', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const duplicateTemplate = async (templateId: string) => {
    try {
      const response = await fetch(`/api/prompt-builder/templates/${templateId}/duplicate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });

      if (response.ok) {
        toast({ title: 'Template duplicated successfully!', variant: 'success' });
        fetchTemplates();
      } else {
        const error = await response.json();
        toast({ title: error.error || 'Failed to duplicate template', variant: 'destructive' });
      }
    } catch (error) {
      toast({ title: 'Failed to duplicate template', variant: 'destructive' });
    }
  };

  const deleteSession = async (sessionId: string) => {
    if (!confirm('Are you sure you want to delete this session?')) return;

    try {
      const response = await fetch(`/api/prompt-builder/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });

      if (response.ok) {
        toast({ title: 'Session deleted successfully!', variant: 'success' });
        fetchSessions();
      } else {
        const error = await response.json();
        toast({ title: error.error || 'Failed to delete session', variant: 'destructive' });
      }
    } catch (error) {
      toast({ title: 'Failed to delete session', variant: 'destructive' });
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: 'Copied to clipboard!', variant: 'success' });
  };

  const downloadPrompt = (prompt: string, filename: string = 'prompt.md') => {
    const blob = new Blob([prompt], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast({ title: 'Prompt downloaded!', variant: 'success' });
  };

  const toggleSessionSelection = (sessionId: string) => {
    setSelectedSessions(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const toggleAllSessions = () => {
    if (selectedSessions.size === sessions.length) {
      setSelectedSessions(new Set());
    } else {
      setSelectedSessions(new Set(sessions.map(s => s.id)));
    }
  };

  const toggleTemplateSelection = (templateId: string) => {
    setSelectedTemplates(prev => {
      const next = new Set(prev);
      if (next.has(templateId)) next.delete(templateId);
      else next.add(templateId);
      return next;
    });
  };

  const toggleAllTemplates = () => {
    if (selectedTemplates.size === filteredTemplates.length) {
      setSelectedTemplates(new Set());
    } else {
      setSelectedTemplates(new Set(filteredTemplates.map(t => t.id)));
    }
  };

  const updateSession = async (sessionId: string, newPrompt: string) => {
    try {
      setSavingPrompt(true);
      await promptSessionsAPI.update(sessionId, newPrompt);
      toast({ title: 'Prompt saved successfully!', variant: 'success' });
      setEditingPrompt(false);
      // Update local state
      if (viewingSession) {
        setViewingSession({ ...viewingSession, generatedPrompt: newPrompt });
      }
      fetchSessions();
    } catch (error) {
      toast({ title: 'Failed to save prompt', variant: 'destructive' });
    } finally {
      setSavingPrompt(false);
    }
  };

  const openGitHubPushModal = async (type: 'sessions' | 'templates') => {
    try {
      const data = await githubAPI.getSettings();
      if (!data || !data.connected) {
        toast({ title: 'GitHub not connected. Go to Settings first.', variant: 'destructive' });
        return;
      }
      const reposList = await githubAPI.listRepos();
      setRepos(reposList.repos || []);
      setGitHubPushType(type);
      setPushPath(type === 'templates' ? 'templates' : 'prompts');
      setShowGitHubModal(true);
    } catch (error) {
      toast({ title: 'GitHub not connected. Go to Settings first.', variant: 'destructive' });
    }
  };

  const handleRepoChange = async (repoFullName: string) => {
    setSelectedRepo(repoFullName);
    if (repoFullName) {
      try {
        const [owner, repo] = repoFullName.split('/');
        const data = await githubAPI.listBranches(owner, repo);
        setBranches(data.branches || []);
      } catch {
        setBranches(['main']);
      }
    }
  };

  const pushToGitHub = async () => {
    if (!selectedRepo) return;
    try {
      setPushing(true);
      let result;
      if (gitHubPushType === 'templates') {
        if (selectedTemplates.size === 0) return;
        result = await githubAPI.pushTemplates({
          templateIds: Array.from(selectedTemplates),
          repo: selectedRepo,
          branch: selectedBranch,
          path: pushPath,
        });
      } else {
        if (selectedSessions.size === 0) return;
        result = await githubAPI.pushPrompts({
          sessionIds: Array.from(selectedSessions),
          repo: selectedRepo,
          branch: selectedBranch,
          path: pushPath,
        });
      }
      if (result.success) {
        toast({ title: `Pushed ${result.results.length} item(s) to GitHub!`, variant: 'success' });
        setShowGitHubModal(false);
        if (gitHubPushType === 'templates') {
          setSelectedTemplates(new Set());
        } else {
          setSelectedSessions(new Set());
        }
      } else {
        toast({ title: 'Some items failed to push', variant: 'destructive' });
      }
    } catch (error) {
      toast({ title: 'Failed to push to GitHub', variant: 'destructive' });
    } finally {
      setPushing(false);
    }
  };

  const addCustomRequirement = () => {
    setCustomRequirements([...customRequirements, '']);
  };

  const updateCustomRequirement = (index: number, value: string) => {
    const updated = [...customRequirements];
    updated[index] = value;
    setCustomRequirements(updated);
  };


  const removeCustomRequirement = (index: number) => {
    setCustomRequirements(customRequirements.filter((_, i) => i !== index));
  };

  const createTemplate = async () => {
    if (!newTemplate.name.trim() || !newTemplate.applicationType || !newTemplate.category) {
      toast({ title: 'Please fill in all required fields', variant: 'destructive' });
      return;
    }

    try {
      setLoading(true);

      // Debug logging
      console.log('🔍 Original form data:', newTemplate);

      const dbFormatData = convertFormDataToDbFormat(newTemplate);
      console.log('🔍 Converted DB format:', dbFormatData);

      const response = await fetch('/api/prompt-builder/templates', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify(dbFormatData)
      });

      if (response.ok) {
        toast({ title: 'Template created successfully!', variant: 'success' });

        resetNewTemplate();

        await fetchTemplates();
        setCreatingTemplate(false);
      } else {
        const error = await response.json();
        toast({ title: error.error || 'Failed to create template', variant: 'destructive' });
      }
    } catch (error) {
      toast({ title: 'Failed to create template', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const updateTemplate = async () => {
    if (!newTemplate.name.trim() || !newTemplate.applicationType || !newTemplate.category) {
      toast({ title: 'Please fill in all required fields', variant: 'destructive' });
      return;
    }

    try {
      setLoading(true);
      const response = await fetch(`/api/prompt-builder/templates/${editingTemplate?.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify(convertFormDataToDbFormat(newTemplate))
      });

      if (response.ok) {
        toast({ title: 'Template updated successfully!', variant: 'success' });

        resetNewTemplate();

        await fetchTemplates();
        setCreatingTemplate(false);
        setEditingTemplate(null);
      } else {
        const error = await response.json();
        toast({ title: error.error || 'Failed to update template', variant: 'destructive' });
      }
    } catch (error) {
      toast({ title: 'Failed to update template', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const convertFormDataToDbFormat = (formData: any) => {
    return {
      name: formData.name,
      description: formData.description,
      applicationType: formData.applicationType,
      category: formData.category,
      tags: formData.tags,
      guidelines: [
        ...formData.guidelines.architecture.map((item: string) => ({
          title: item,
          description: item,
          priority: 'medium' as const,
          examples: []
        })),
        ...formData.guidelines.structure.map((item: string) => ({
          title: item,
          description: item,
          priority: 'medium' as const,
          examples: []
        })),
        ...formData.guidelines.performance.map((item: string) => ({
          title: item,
          description: item,
          priority: 'medium' as const,
          examples: []
        }))
      ],
      standards: [
        ...formData.standards.naming.map((item: string) => ({
          name: item,
          description: item,
          type: 'naming',
          rules: [item],
          examples: []
        })),
        ...formData.standards.formatting.map((item: string) => ({
          name: item,
          description: item,
          type: 'formatting',
          rules: [item],
          examples: []
        })),
        ...formData.standards.documentation.map((item: string) => ({
          name: item,
          description: item,
          type: 'documentation',
          rules: [item],
          examples: []
        }))
      ],
      libraries: [
        ...formData.libraries.core.map((item: string) => ({
          name: item,
          description: item,
          version: 'latest',
          category: 'core',
          required: true,
          installation: `npm install ${item}`,
          usage: item,
          alternatives: []
        })),
        ...formData.libraries.ui.map((item: string) => ({
          name: item,
          description: item,
          version: 'latest',
          category: 'ui',
          required: false,
          installation: `npm install ${item}`,
          usage: item,
          alternatives: []
        })),
        ...formData.libraries.utilities.map((item: string) => ({
          name: item,
          description: item,
          version: 'latest',
          category: 'utilities',
          required: false,
          installation: `npm install ${item}`,
          usage: item,
          alternatives: []
        }))
      ],
      architecture: {
        pattern: formData.architecture.patterns.join(', ') || 'Component-based',
        description: 'Application architecture pattern',
        structure: {
          directories: formData.architecture.patterns,
          files: formData.architecture.dataFlow,
          conventions: formData.architecture.routing
        },
        dataFlow: formData.architecture.dataFlow.join(', ') || 'Unidirectional',
        stateManagement: 'React State',
        apiDesign: 'RESTful'
      },
      security: [
        ...formData.security.authentication.split('\n').filter(item => item.trim()).map((item: string) => ({
          title: item,
          description: item,
          threat: 'Authentication',
          priority: 'high' as const,
          mitigation: [item],
          tools: []
        })),
        ...formData.security.dataProtection.split('\n').filter(item => item.trim()).map((item: string) => ({
          title: item,
          description: item,
          threat: 'Data Protection',
          priority: 'high' as const,
          mitigation: [item],
          tools: []
        })),
        ...formData.security.dependencies.split('\n').filter(item => item.trim()).map((item: string) => ({
          title: item,
          description: item,
          threat: 'Dependencies',
          priority: 'medium' as const,
          mitigation: [item],
          tools: []
        }))
      ],
      performance: [
        ...formData.performance.optimization.split('\n').filter(item => item.trim()).map((item: string) => ({
          title: item,
          description: item,
          impact: 'medium' as const,
          optimization: [item],
          metrics: [],
          tools: []
        })),
        ...formData.performance.monitoring.split('\n').filter(item => item.trim()).map((item: string) => ({
          title: item,
          description: item,
          impact: 'medium' as const,
          optimization: [item],
          metrics: [],
          tools: []
        })),
        ...formData.performance.loading.split('\n').filter(item => item.trim()).map((item: string) => ({
          title: item,
          description: item,
          impact: 'medium' as const,
          optimization: [item],
          metrics: [],
          tools: []
        }))
      ],
      testing: [
        ...formData.testing.unit.split('\n').filter(item => item.trim()).map((item: string) => ({
          type: 'unit',
          framework: 'jest',
          description: item,
          coverage: '80%',
          examples: [item]
        })),
        ...formData.testing.integration.split('\n').filter(item => item.trim()).map((item: string) => ({
          type: 'integration',
          framework: 'jest',
          description: item,
          coverage: '70%',
          examples: [item]
        })),
        ...formData.testing.e2e.split('\n').filter(item => item.trim()).map((item: string) => ({
          type: 'e2e',
          framework: 'cypress',
          description: item,
          coverage: '60%',
          examples: [item]
        }))
      ],
      deployment: [
        ...formData.deployment.build.split('\n').filter(item => item.trim()).map((item: string) => ({
          platform: 'build',
          description: item,
          steps: [item],
          configuration: [],
          monitoring: []
        })),
        ...formData.deployment.hosting.split('\n').filter(item => item.trim()).map((item: string) => ({
          platform: 'hosting',
          description: item,
          steps: [item],
          configuration: [],
          monitoring: []
        })),
        ...formData.deployment.cicd.split('\n').filter(item => item.trim()).map((item: string) => ({
          platform: 'cicd',
          description: item,
          steps: [item],
          configuration: [],
          monitoring: []
        }))
      ],
      precautions: [
        ...formData.precautions.common_issues.split('\n').filter(item => item.trim()).map((item: string) => ({
          title: item,
          description: item,
          severity: 'medium' as const,
          prevention: [item]
        })),
        ...formData.precautions.performance_pitfalls.split('\n').filter(item => item.trim()).map((item: string) => ({
          title: item,
          description: item,
          severity: 'medium' as const,
          prevention: [item]
        })),
        ...formData.precautions.security_risks.split('\n').filter(item => item.trim()).map((item: string) => ({
          title: item,
          description: item,
          severity: 'high' as const,
          prevention: [item]
        }))
      ],
      customSections: formData.customSections,
    };
  };

  const convertDbFormatToForm = (template: any) => {
    console.log('🔄 Loading template from DB:', template.name);

    const result = {
      name: template.name || '',
      description: template.description || '',
      applicationType: template.applicationType || '',
      category: template.category || '',
      tags: template.tags || [],
      guidelines: {
        architecture: Array.isArray(template.guidelines?.architecture) ? template.guidelines.architecture : [],
        structure: Array.isArray(template.guidelines?.structure) ? template.guidelines.structure : [],
        performance: Array.isArray(template.guidelines?.performance) ? template.guidelines.performance : []
      },
      standards: {
        naming: Array.isArray(template.standards?.naming) ? template.standards.naming : [],
        formatting: Array.isArray(template.standards?.formatting) ? template.standards.formatting : [],
        documentation: Array.isArray(template.standards?.documentation) ? template.standards.documentation : []
      },
      libraries: {
        core: Array.isArray(template.libraries?.core) ? template.libraries.core : [],
        ui: Array.isArray(template.libraries?.ui) ? template.libraries.ui : [],
        utilities: Array.isArray(template.libraries?.utilities) ? template.libraries.utilities : []
      },
      architecture: {
        patterns: Array.isArray(template.architecture?.patterns) ? template.architecture.patterns : [],
        dataFlow: Array.isArray(template.architecture?.dataFlow) ? template.architecture.dataFlow : [],
        routing: Array.isArray(template.architecture?.routing) ? template.architecture.routing : []
      },
      security: {
        authentication: Array.isArray(template.security) ? template.security.filter(item => item.threat === 'Authentication').map(item => item.title || item.description).join('\n') : '',
        dataProtection: Array.isArray(template.security) ? template.security.filter(item => item.threat === 'Data Protection').map(item => item.title || item.description).join('\n') : '',
        dependencies: Array.isArray(template.security) ? template.security.filter(item => item.threat === 'Dependencies').map(item => item.title || item.description).join('\n') : ''
      },
      performance: {
        optimization: Array.isArray(template.performance) ? template.performance.filter(item => item.title && item.optimization).map(item => item.title).join('\n') : '',
        monitoring: Array.isArray(template.performance) ? template.performance.filter(item => item.title && item.optimization).map(item => item.title).join('\n') : '',
        loading: Array.isArray(template.performance) ? template.performance.filter(item => item.title && item.optimization).map(item => item.title).join('\n') : ''
      },
      testing: {
        unit: Array.isArray(template.testing) ? template.testing.filter(item => item.type === 'unit').map(item => item.description).join('\n') : '',
        integration: Array.isArray(template.testing) ? template.testing.filter(item => item.type === 'integration').map(item => item.description).join('\n') : '',
        e2e: Array.isArray(template.testing) ? template.testing.filter(item => item.type === 'e2e').map(item => item.description).join('\n') : ''
      },
      deployment: {
        build: Array.isArray(template.deployment) ? template.deployment.filter(item => item.platform === 'build').map(item => item.description).join('\n') : '',
        hosting: Array.isArray(template.deployment) ? template.deployment.filter(item => item.platform === 'hosting').map(item => item.description).join('\n') : '',
        cicd: Array.isArray(template.deployment) ? template.deployment.filter(item => item.platform === 'cicd').map(item => item.description).join('\n') : ''
      },
      precautions: {
        common_issues: Array.isArray(template.precautions) ? template.precautions.filter(item => item.severity === 'medium' && item.title).map(item => item.title).join('\n') : '',
        performance_pitfalls: Array.isArray(template.precautions) ? template.precautions.filter(item => item.severity === 'medium' && item.title).map(item => item.title).join('\n') : '',
        security_risks: Array.isArray(template.precautions) ? template.precautions.filter(item => item.severity === 'high' && item.title).map(item => item.title).join('\n') : ''
      },
      customSections: template.customSections || [],
    };

    console.log('🔄 Converted form data:', result);

    return result;
  };

  const filteredTemplates = templates.filter(template => {
    const matchesSearch = template.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      template.description.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesType = !filterType || template.applicationType === filterType;
    const matchesCategory = !filterCategory || template.category === filterCategory;
    return matchesSearch && matchesType && matchesCategory;
  });

  const viewTemplate = (template: PromptTemplate) => {
    setViewingTemplate(template);
  };

  const closeTemplateView = () => {
    setViewingTemplate(null);
    fetchTemplates(); // Refresh templates list
  };

  const copyTemplateContent = (template: PromptTemplate) => {
    const content = `# ${template.name}

${template.description}

**Application Type:** ${template.applicationType}
**Category:** ${template.category}
**Tags:** ${template.tags?.join(', ') || 'None'}

## Architecture
${template.architecture}

## Guidelines
${JSON.stringify(template.guidelines, null, 2)}

## Standards
${JSON.stringify(template.standards, null, 2)}

## Libraries
${JSON.stringify(template.libraries, null, 2)}

## Security
${JSON.stringify(template.security, null, 2)}

## Performance
${JSON.stringify(template.performance, null, 2)}

## Testing
${JSON.stringify(template.testing, null, 2)}

## Deployment
${JSON.stringify(template.deployment, null, 2)}

## Precautions
${JSON.stringify(template.precautions, null, 2)}
`;

    navigator.clipboard.writeText(content).then(() => {
      toast({ title: 'Template content copied to clipboard', variant: 'success' });
    }).catch(() => {
      toast({ title: 'Failed to copy template content', variant: 'destructive' });
    });
  };

  const renderTemplatesTab = () => (
    <div className="space-y-6">
      {/* Header with Create Button */}
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold text-gray-900">Templates</h2>
          {filteredTemplates.length > 0 && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={selectedTemplates.size === filteredTemplates.length && filteredTemplates.length > 0}
                onChange={toggleAllTemplates}
                className="w-4 h-4 rounded border-gray-300"
              />
              <span className="text-sm text-gray-600">
                {selectedTemplates.size > 0 ? `${selectedTemplates.size} selected` : 'Select all'}
              </span>
            </label>
          )}
        </div>
        <div className="flex gap-2">
          {selectedTemplates.size > 0 && (
            <Button
              size="sm"
              onClick={() => openGitHubPushModal('templates')}
              className="bg-gray-900 hover:bg-gray-800 text-white"
            >
              <GitBranch className="w-4 h-4 mr-2" />
              Push to GitHub ({selectedTemplates.size})
            </Button>
          )}
          <Button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setCreatingTemplate(true);
            }}
            className="flex items-center gap-2"
            type="button"
          >
            <Plus className="w-4 h-4" />
            Create New Template
          </Button>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="flex-1">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
            <Input
              placeholder="Search templates..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All Types</option>
          {metadata?.applicationTypes.map(type => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>
        <select
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All Categories</option>
          {metadata?.categories.map(category => (
            <option key={category} value={category}>{category}</option>
          ))}
        </select>
      </div>

      {/* Templates Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredTemplates.map(template => (
          <Card key={template.id} className={`p-6 ${selectedTemplates.has(template.id) ? 'ring-2 ring-blue-500 bg-blue-50/30' : ''}`}>
            <div className="flex justify-between items-start mb-4">
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={selectedTemplates.has(template.id)}
                  onChange={() => toggleTemplateSelection(template.id)}
                  className="w-4 h-4 mt-1 rounded border-gray-300 cursor-pointer"
                />
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">{template.name}</h3>
                  <p className="text-sm text-gray-600 mt-1">{template.description}</p>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2 mb-4">
              <span className="px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded-full">
                {template.applicationType}
              </span>
              <span className="px-2 py-1 bg-green-100 text-green-800 text-xs rounded-full">
                {template.category}
              </span>
              {template.tags?.map(tag => (
                <span key={tag} className="px-2 py-1 bg-gray-100 text-gray-800 text-xs rounded-full">
                  {tag}
                </span>
              ))}
            </div>

            <div className="flex justify-between items-center">
              <span className="text-xs text-gray-500">
                {new Date(template.createdAt).toLocaleDateString()}
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => viewTemplate(template)}
                >
                  <Eye className="w-4 h-4" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => copyTemplateContent(template)}
                >
                  <Copy className="w-4 h-4" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => duplicateTemplate(template.id)}
                >
                  <Copy className="w-4 h-4" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (!confirm('Are you sure you want to delete this template?')) return;
                    fetch('/api/prompt-builder/templates/' + template.id, {
                      method: 'DELETE',
                      headers: {
                        'Authorization': `Bearer ${localStorage.getItem('token')}`
                      }
                    })
                      .then(response => {
                        if (response.ok) {
                          toast({ title: 'Template deleted successfully!', variant: 'success' });
                          fetchTemplates();
                        } else {
                          const error = response.json();
                          toast({ title: error.error || 'Failed to delete template', variant: 'destructive' });
                        }
                      })
                      .catch(error => {
                        toast({ title: 'Failed to delete template', variant: 'destructive' });
                      });
                  }}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditingTemplate(template);
                    setCreatingTemplate(true);
                  }}
                >
                  <Edit className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {filteredTemplates.length === 0 && (
        <div className="text-center py-12">
          <FileText className="mx-auto w-12 h-12 text-gray-400 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No templates found</h3>
          <p className="text-gray-600">Try adjusting your search or filters.</p>
        </div>
      )}
    </div>
  );

  const renderSessionsTab = () => (
    <div className="space-y-6">
      {/* Action bar */}
      {sessions.length > 0 && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={selectedSessions.size === sessions.length && sessions.length > 0}
                onChange={toggleAllSessions}
                className="w-4 h-4 rounded border-gray-300"
              />
              <span className="text-sm text-gray-600">
                {selectedSessions.size > 0 ? `${selectedSessions.size} selected` : 'Select all'}
              </span>
            </label>
          </div>
          {selectedSessions.size > 0 && (
            <Button
              size="sm"
              onClick={() => openGitHubPushModal('sessions')}
              className="bg-gray-900 hover:bg-gray-800 text-white"
            >
              <GitBranch className="w-4 h-4 mr-2" />
              Push to GitHub ({selectedSessions.size})
            </Button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4">
        {sessions.map(session => (
          <Card key={session.id} className={`p-6 ${selectedSessions.has(session.id) ? 'ring-2 ring-blue-500 bg-blue-50/30' : ''}`}>
            <div className="flex justify-between items-start">
              <div className="flex items-start gap-3 flex-1">
                <input
                  type="checkbox"
                  checked={selectedSessions.has(session.id)}
                  onChange={() => toggleSessionSelection(session.id)}
                  className="w-4 h-4 mt-1 rounded border-gray-300 cursor-pointer"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="text-lg font-semibold">{session.template?.name || 'Unknown Template'}</h3>
                    <span className="px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded-full">
                      {session.template?.applicationType}
                    </span>
                  </div>
                  <p className="text-gray-600 mb-3 line-clamp-2">{session.projectDescription}</p>
                  <div className="flex items-center gap-4 text-sm text-gray-500">
                    <span className="flex items-center gap-1">
                      <Clock className="w-4 h-4" />
                      {new Date(session.createdAt).toLocaleDateString()}
                    </span>
                    <span>{session.selectedFeatures.length} features</span>
                    <span>{session.customRequirements.length} requirements</span>
                  </div>
                </div>
              </div>
              <div className="flex gap-2 ml-4">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setViewingSession(session);
                    setEditingPrompt(false);
                    setEditedPromptText(session.generatedPrompt);
                  }}
                >
                  <Eye className="w-4 h-4" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => copyToClipboard(session.generatedPrompt)}
                >
                  <Copy className="w-4 h-4" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => downloadPrompt(session.generatedPrompt, `prompt-${session.id}.md`)}
                >
                  <Download className="w-4 h-4" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => deleteSession(session.id)}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {sessions.length === 0 && (
        <div className="text-center py-12">
          <Clock className="mx-auto w-12 h-12 text-gray-400 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No sessions found</h3>
          <p className="text-gray-600">Generate your first prompt to see it here.</p>
        </div>
      )}
    </div>
  );

  const renderGenerateTab = () => (
    <div className="max-w-4xl mx-auto space-y-6">
      <Card className="p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Generate New Prompt</h3>

        <div className="space-y-6">
          {/* Template Selection */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Select Template
            </label>
            <select
              value={selectedTemplate}
              onChange={(e) => setSelectedTemplate(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Choose a template...</option>
              {templates.map(template => (
                <option key={template.id} value={template.id}>
                  {template.name} ({template.applicationType})
                </option>
              ))}
            </select>
          </div>

          {/* Project Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Project Description
            </label>
            <textarea
              value={projectDescription}
              onChange={(e) => setProjectDescription(e.target.value)}
              placeholder="Describe your project in detail..."
              rows={4}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Key Features */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Key Features (one per line)
            </label>
            <textarea
              value={selectedFeatures.join('\n')}
              onChange={(e) => setSelectedFeatures(e.target.value.split('\n').filter(f => f.trim()))}
              placeholder="Feature 1&#10;Feature 2&#10;Feature 3"
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Custom Requirements */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Custom Requirements
            </label>
            {customRequirements.map((requirement, index) => (
              <div key={index} className="flex gap-2 mb-2">
                <Input
                  value={requirement}
                  onChange={(e) => updateCustomRequirement(index, e.target.value)}
                  placeholder="Enter custom requirement..."
                  className="flex-1"
                />
                {customRequirements.length > 1 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => removeCustomRequirement(index)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              onClick={addCustomRequirement}
              className="mt-2"
            >
              <Plus className="w-4 h-4 mr-2" />
              Add Requirement
            </Button>
          </div>

          {/* Attach Project Documents */}
          <div className="border border-gray-200 rounded-lg p-4 bg-gray-50/50">
            <div className="flex items-center gap-2 mb-3">
              <Paperclip className="w-4 h-4 text-blue-600" />
              <label className="block text-sm font-medium text-gray-700">
                Attach Project Documents <span className="text-gray-400 font-normal">(optional)</span>
              </label>
            </div>
            <p className="text-xs text-gray-500 mb-3">
              Include generated project documents in your prompt. Documents are embedded as summaries with file path references for AI coding tools.
            </p>

            {/* Project Selector */}
            <select
              value={selectedProject}
              onChange={(e) => setSelectedProject(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 mb-3 text-sm"
            >
              <option value="">Select a project to attach documents...</option>
              {projects.map((project: any) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>

            {/* Document Checkboxes */}
            {selectedProject && projectDocuments.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-gray-600">
                    {selectedDocumentIds.size} of {projectDocuments.length} documents selected
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      if (selectedDocumentIds.size === projectDocuments.length) {
                        setSelectedDocumentIds(new Set());
                      } else {
                        setSelectedDocumentIds(new Set(projectDocuments.map((d: any) => d.id)));
                      }
                    }}
                    className="text-xs text-blue-600 hover:text-blue-800"
                  >
                    {selectedDocumentIds.size === projectDocuments.length ? 'Deselect All' : 'Select All'}
                  </button>
                </div>
                {projectDocuments.map((doc: any) => {
                  const docTypeLabels: Record<string, string> = {
                    prd: 'PRD',
                    requirements: 'Requirements',
                    techstack: 'Tech Stack',
                    frontend: 'Frontend Guide',
                    backend: 'Backend Guide',
                    flow: 'App Flow',
                    status: 'Project Status',
                  };
                  return (
                    <label key={doc.id} className="flex items-center gap-2 cursor-pointer p-2 rounded hover:bg-gray-100">
                      <input
                        type="checkbox"
                        checked={selectedDocumentIds.has(doc.id)}
                        onChange={() => {
                          const next = new Set(selectedDocumentIds);
                          if (next.has(doc.id)) {
                            next.delete(doc.id);
                          } else {
                            next.add(doc.id);
                          }
                          setSelectedDocumentIds(next);
                        }}
                        className="w-4 h-4 rounded border-gray-300"
                      />
                      <FileText className="w-4 h-4 text-gray-400" />
                      <span className="text-sm text-gray-700">
                        {docTypeLabels[doc.documentType] || doc.documentType}
                      </span>
                      <span className="text-xs text-gray-400 ml-auto">
                        {doc.content ? `${Math.round(doc.content.length / 1024)}KB` : ''}
                      </span>
                    </label>
                  );
                })}

                {/* Docs Path Input */}
                <div className="mt-3 flex items-center gap-2">
                  <FolderOpen className="w-4 h-4 text-gray-400" />
                  <Input
                    value={docsPath}
                    onChange={(e) => setDocsPath(e.target.value)}
                    placeholder="docs"
                    className="flex-1 text-sm"
                  />
                  <span className="text-xs text-gray-400 whitespace-nowrap">file path prefix</span>
                </div>
              </div>
            )}

            {selectedProject && projectDocuments.length === 0 && (
              <p className="text-xs text-gray-400 italic">No documents found for this project. Generate documents first in the MVP Generator.</p>
            )}
          </div>

          {/* Generate Button */}
          <Button
            onClick={generatePrompt}
            disabled={loading || !selectedTemplate || !projectDescription.trim()}
            className="w-full"
          >
            <Zap className="w-4 h-4 mr-2" />
            {loading ? 'Generating...' : 'Generate Prompt'}
          </Button>
        </div>
      </Card>

      {/* Generated Prompt */}
      {generatedPrompt && (
        <Card className="p-6">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-semibold">Generated Prompt</h3>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => copyToClipboard(generatedPrompt)}
              >
                <Copy className="w-4 h-4 mr-2" />
                Copy
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => downloadPrompt(generatedPrompt)}
              >
                <Download className="w-4 h-4 mr-2" />
                Download
              </Button>
            </div>
          </div>
          <div className="bg-gray-50 rounded-md p-4 max-h-96 overflow-y-auto">
            <pre className="whitespace-pre-wrap text-sm text-gray-800">{generatedPrompt}</pre>
          </div>
        </Card>
      )}
    </div>
  );

  // ==========================
  // RENDER: Build Tab
  // ==========================
  const renderBuildTab = () => (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-600 to-purple-600 flex items-center justify-center">
            <Rocket className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-gray-900">Build with OpenHands</h2>
            <p className="text-sm text-gray-500">Send prompts to an AI agent that builds your project</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {openhandsConnected ? (
            <span className="text-xs px-3 py-1.5 bg-green-100 text-green-700 rounded-full font-medium">● Connected</span>
          ) : (
            <span className="text-xs px-3 py-1.5 bg-gray-100 text-gray-500 rounded-full font-medium">○ Not Connected</span>
          )}
        </div>
      </div>

      {/* Connection Form (if not connected) */}
      {!openhandsConnected && (
        <Card className="p-6 border-2 border-indigo-100">
          <div className="flex items-center gap-2 mb-4">
            <Settings className="w-5 h-5 text-indigo-600" />
            <h3 className="text-lg font-semibold text-gray-900">Connect OpenHands</h3>
          </div>
          <p className="text-sm text-gray-500 mb-4">
            Get your API key from <a href="https://app.all-hands.dev" target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline font-medium">app.all-hands.dev</a> → Account Settings → API Keys
          </p>
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
              <Input
                type="password"
                value={openhandsApiKey}
                onChange={(e) => setOpenhandsApiKey(e.target.value)}
                placeholder="Enter your OpenHands API key"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Default Repository (optional)</label>
              <Input
                value={openhandsRepo}
                onChange={(e) => setOpenhandsRepo(e.target.value)}
                placeholder="e.g. your-username/your-repo (must exist on GitHub)"
              />
            </div>
            <Button
              onClick={async () => {
                if (!openhandsApiKey.trim()) {
                  toast({ title: 'API key required', variant: 'destructive' });
                  return;
                }
                setSavingOpenhandsSettings(true);
                try {
                  await openhandsAPI.saveSettings({
                    apiKey: openhandsApiKey.trim(),
                    defaultRepo: openhandsRepo.trim() || undefined,
                  });
                  setOpenhandsConnected(true);
                  setOpenhandsApiKey('');
                  toast({ title: '✓ OpenHands connected!' });
                } catch (error: any) {
                  toast({
                    title: 'Connection failed',
                    description: error.response?.data?.error || 'Invalid API key or connection error',
                    variant: 'destructive',
                  });
                } finally {
                  setSavingOpenhandsSettings(false);
                }
              }}
              disabled={savingOpenhandsSettings || !openhandsApiKey.trim()}
              className="w-full bg-indigo-600 hover:bg-indigo-700 text-white"
            >
              {savingOpenhandsSettings ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Validating...</>
              ) : (
                <><Check className="w-4 h-4 mr-2" />Connect OpenHands</>
              )}
            </Button>
          </div>
        </Card>
      )}

      {/* Build Controls (when connected) */}
      {openhandsConnected && (
        <Card className="p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Launch a Build</h3>
          <div className="space-y-4">
            {/* Prompt Selector */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Select Prompt to Build</label>
              <select
                value={selectedBuildPrompt ? 'custom' : ''}
                onChange={(e) => {
                  if (e.target.value === 'current') {
                    setSelectedBuildPrompt(generatedPrompt);
                  } else if (e.target.value === '') {
                    setSelectedBuildPrompt('');
                  } else {
                    const session = sessions.find(s => s.id === e.target.value);
                    if (session) setSelectedBuildPrompt(session.generatedPrompt);
                  }
                }}
                className="w-full rounded-md border border-gray-300 p-2 text-sm focus:ring-indigo-500 focus:border-indigo-500"
              >
                <option value="">-- Select a prompt --</option>
                {generatedPrompt && (
                  <option value="current">📝 Current generated prompt</option>
                )}
                {sessions.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.template?.name || 'Untitled'} — {new Date(s.createdAt).toLocaleDateString()}
                  </option>
                ))}
              </select>
              {selectedBuildPrompt && (
                <div className="mt-2 bg-gray-50 rounded-md p-3 max-h-32 overflow-y-auto">
                  <pre className="text-xs text-gray-600 whitespace-pre-wrap">{selectedBuildPrompt.substring(0, 500)}{selectedBuildPrompt.length > 500 ? '...' : ''}</pre>
                </div>
              )}
            </div>

            {/* Repository */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Target Repository</label>
              <Input
                value={openhandsRepo}
                onChange={(e) => setOpenhandsRepo(e.target.value)}
                placeholder="e.g. your-username/your-repo (must exist on GitHub)"
              />
              <p className="text-xs text-gray-400 mt-1">
                The AI agent will create a PR with the built project in this repo
              </p>
            </div>

            {/* Launch Button */}
            <Button
              onClick={startOpenhandsBuild}
              disabled={openhandsBuilding || !openhandsRepo || !(selectedBuildPrompt || generatedPrompt)}
              className="w-full bg-indigo-600 hover:bg-indigo-700 text-white h-12 text-base"
            >
              {openhandsBuilding ? (
                <><Loader2 className="w-5 h-5 mr-2 animate-spin" />Launching Build...</>
              ) : (
                <><Rocket className="w-5 h-5 mr-2" />Launch Build</>
              )}
            </Button>
          </div>
        </Card>
      )}

      {/* Active Build Status Dashboard */}
      {openhandsBuildInfo && (
        <Card className="p-0 overflow-hidden">
          {/* Status Header */}
          <div className="px-6 py-4 bg-gradient-to-r from-indigo-50 to-purple-50 border-b border-indigo-100">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${openhandsBuildInfo.status === 'completed' ? 'bg-green-100' :
                  openhandsBuildInfo.status === 'failed' ? 'bg-red-100' :
                    'bg-indigo-100'
                  }`}>
                  {openhandsBuildInfo.status === 'completed' ? (
                    <Check className="w-5 h-5 text-green-600" />
                  ) : openhandsBuildInfo.status === 'failed' ? (
                    <X className="w-5 h-5 text-red-600" />
                  ) : (
                    <Loader2 className="w-5 h-5 text-indigo-600 animate-spin" />
                  )}
                </div>
                <div>
                  <h3 className="text-base font-semibold text-gray-900">Active Build</h3>
                  <span className={`text-xs font-medium ${openhandsBuildInfo.status === 'completed' ? 'text-green-600' :
                    openhandsBuildInfo.status === 'failed' ? 'text-red-600' :
                      'text-indigo-600'
                    }`}>
                    {openhandsBuildInfo.status === 'completed' ? 'Build Completed Successfully' :
                      openhandsBuildInfo.status === 'failed' ? 'Build Failed' :
                        openhandsBuildInfo.status === 'running' ? 'AI Agent is building your project...' :
                          'Build starting up...'}
                  </span>
                </div>
              </div>
              <Button
                onClick={() => window.open(openhandsBuildInfo.conversationUrl, '_blank', 'noopener')}
                className="bg-indigo-600 hover:bg-indigo-700 text-white"
              >
                <ExternalLink className="w-4 h-4 mr-2" /> Open in OpenHands
              </Button>
            </div>
          </div>

          {/* Build Details */}
          <div className="px-6 py-4 space-y-3">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-xs text-gray-400 uppercase tracking-wide">Repository</span>
                <p className="font-medium text-gray-900 mt-0.5">{openhandsBuildInfo.repository}</p>
              </div>
              <div>
                <span className="text-xs text-gray-400 uppercase tracking-wide">Conversation ID</span>
                <p className="font-mono text-gray-700 mt-0.5 text-xs">{openhandsBuildInfo.conversationId}</p>
              </div>
            </div>

            {/* Progress indicator for running builds */}
            {['running', 'started'].includes(openhandsBuildInfo.status) && (
              <div className="mt-2 p-3 bg-blue-50 rounded-lg border border-blue-100">
                <div className="flex items-center gap-2 text-sm text-blue-700">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>The AI agent is working on your project. Status updates every 10 seconds.</span>
                </div>
                <p className="text-xs text-blue-500 mt-1">
                  Click &quot;Open in OpenHands&quot; above to watch the agent work in real-time.
                </p>
              </div>
            )}

            {openhandsBuildInfo.status === 'completed' && (
              <div className="mt-2 p-3 bg-green-50 rounded-lg border border-green-100">
                <p className="text-sm text-green-700">
                  Your project has been built! Check the repository for a new Pull Request.
                </p>
              </div>
            )}

            {openhandsBuildInfo.status === 'failed' && (
              <div className="mt-2 p-3 bg-red-50 rounded-lg border border-red-100">
                <p className="text-sm text-red-700">
                  The build encountered an error. Open the OpenHands dashboard for details.
                </p>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Build History */}
      {openhandsConnected && buildsList.length > 0 && (
        <Card className="p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Build History</h3>
          <div className="space-y-3">
            {buildsList.map((build: any) => (
              <div
                key={build.id}
                className="flex items-center justify-between p-3 rounded-lg border border-gray-200 hover:bg-gray-50 cursor-pointer"
                onClick={() => {
                  setOpenhandsBuildInfo({
                    id: build.id,
                    conversationId: build.conversationId,
                    conversationUrl: build.conversationUrl || `https://app.all-hands.dev/conversations/${build.conversationId}`,
                    status: build.status,
                    repository: build.repository,
                  });
                }}
              >
                <div className="flex items-center gap-3">
                  <span className={`w-2 h-2 rounded-full ${build.status === 'completed' ? 'bg-green-500' :
                    build.status === 'failed' ? 'bg-red-500' :
                      build.status === 'running' ? 'bg-blue-500' :
                        'bg-yellow-500'
                    }`} />
                  <div>
                    <p className="text-sm font-medium text-gray-900">{build.repository}</p>
                    <p className="text-xs text-gray-500">{new Date(build.createdAt).toLocaleString()}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${build.status === 'completed' ? 'bg-green-100 text-green-700' :
                    build.status === 'failed' ? 'bg-red-100 text-red-700' :
                      build.status === 'running' ? 'bg-blue-100 text-blue-700' :
                        'bg-yellow-100 text-yellow-700'
                    }`}>
                    {build.status}
                  </span>
                  <ExternalLink className="w-3.5 h-3.5 text-gray-400" />
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Settings (connected users) */}
      {openhandsConnected && (
        <div className="pt-2">
          <button
            onClick={() => setShowBuildPanel(!showBuildPanel)}
            className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1"
          >
            <Settings className="w-3 h-3" />
            {showBuildPanel ? 'Hide settings' : 'Connection Settings'}
          </button>
          {showBuildPanel && (
            <Card className="mt-3 p-4">
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Update API Key</label>
                  <Input
                    type="password"
                    value={openhandsApiKey}
                    onChange={(e) => setOpenhandsApiKey(e.target.value)}
                    placeholder="Enter new API key (leave blank to keep current)"
                    className="text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Default Repository</label>
                  <Input
                    value={openhandsRepo}
                    onChange={(e) => setOpenhandsRepo(e.target.value)}
                    placeholder="e.g. your-username/your-repo (must exist on GitHub)"
                    className="text-sm"
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={async () => {
                      if (!openhandsApiKey.trim()) {
                        toast({ title: 'Enter a new API key to update', variant: 'destructive' });
                        return;
                      }
                      setSavingOpenhandsSettings(true);
                      try {
                        await openhandsAPI.saveSettings({
                          apiKey: openhandsApiKey.trim(),
                          defaultRepo: openhandsRepo.trim() || undefined,
                        });
                        setOpenhandsApiKey('');
                        toast({ title: '✓ Settings updated!' });
                      } catch (error: any) {
                        toast({
                          title: 'Update failed',
                          description: error.response?.data?.error || 'Failed to update settings',
                          variant: 'destructive',
                        });
                      } finally {
                        setSavingOpenhandsSettings(false);
                      }
                    }}
                    disabled={savingOpenhandsSettings || !openhandsApiKey.trim()}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white"
                  >
                    {savingOpenhandsSettings ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Update'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-red-600 border-red-200 hover:bg-red-50"
                    onClick={async () => {
                      try {
                        await openhandsAPI.disconnect();
                        setOpenhandsConnected(false);
                        setOpenhandsApiKey('');
                        setOpenhandsRepo('');
                        setShowBuildPanel(false);
                        toast({ title: 'OpenHands disconnected' });
                      } catch (e) {
                        toast({ title: 'Failed to disconnect', variant: 'destructive' });
                      }
                    }}
                  >
                    Disconnect
                  </Button>
                </div>
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );

  const guidelinesMapping = {
    web: {
      frontend: {
        architecture: [
          'Use functional components with React Hooks',
          'Implement proper component composition and reusability',
          'Follow React best practices for state management',
          'Use TypeScript for type safety and better developer experience'
        ],
        structure: [
          'Organize components in a logical folder structure',
          'Separate business logic from UI components',
          'Use custom hooks for shared logic',
          'Implement proper error boundaries'
        ],
        performance: [
          'Implement code splitting and lazy loading',
          'Optimize bundle size and loading times',
          'Use React.memo and useMemo for performance optimization',
          'Implement proper caching strategies'
        ]
      },
      fullstack: {
        architecture: [
          'Use modern full-stack framework (Next.js, Nuxt.js, SvelteKit)',
          'Implement proper client-server separation',
          'Use server-side rendering where appropriate',
          'Follow full-stack best practices'
        ],
        structure: [
          'Organize by feature or domain',
          'Separate client and server logic clearly',
          'Use shared types and utilities',
          'Implement proper API layer structure'
        ],
        performance: [
          'Optimize both client and server performance',
          'Implement proper caching strategies',
          'Use CDN for static assets',
          'Optimize database queries and API calls'
        ]
      }
    },
    mobile: {
      native: {
        architecture: [
          'Follow platform-specific design patterns',
          'Use native navigation patterns',
          'Implement proper state management',
          'Follow platform UI guidelines'
        ],
        structure: [
          'Organize by application modules',
          'Separate UI from business logic',
          'Use proper data binding patterns',
          'Implement proper resource management'
        ],
        performance: [
          'Optimize for mobile performance',
          'Implement efficient memory usage',
          'Use proper threading for UI responsiveness',
          'Optimize startup time'
        ]
      },
      crossplatform: {
        architecture: [
          'Use React Native, Flutter, or Xamarin',
          'Implement platform-specific adaptations',
          'Share business logic across platforms',
          'Use proper navigation libraries'
        ],
        structure: [
          'Organize shared and platform-specific code',
          'Use proper component abstraction',
          'Implement platform-specific services',
          'Maintain consistent UI across platforms'
        ],
        performance: [
          'Optimize for multiple platforms',
          'Use platform-specific optimizations',
          'Implement efficient rendering',
          'Minimize bundle size'
        ]
      }
    },
    api: {
      backend: {
        architecture: [
          'Use layered architecture (Controller, Service, Repository)',
          'Implement proper separation of concerns',
          'Use dependency injection where appropriate',
          'Follow RESTful API design principles'
        ],
        structure: [
          'Organize code by feature/domain',
          'Separate routes, controllers, services, and models',
          'Use middleware for cross-cutting concerns',
          'Implement proper error handling'
        ],
        performance: [
          'Implement proper caching strategies',
          'Use connection pooling for databases',
          'Optimize database queries',
          'Implement rate limiting and throttling'
        ]
      },
      microservices: {
        architecture: [
          'Design loosely coupled services',
          'Implement proper service boundaries',
          'Use event-driven architecture',
          'Follow microservices patterns'
        ],
        structure: [
          'Organize by business domains',
          'Implement proper API gateways',
          'Use service mesh for communication',
          'Maintain service independence'
        ],
        performance: [
          'Implement distributed caching',
          'Use asynchronous communication',
          'Optimize inter-service calls',
          'Implement proper load balancing'
        ]
      }
    },
    rag: {
      ai: {
        architecture: [
          'Implement proper document ingestion pipeline',
          'Use vector embeddings for semantic search',
          'Integrate with LLM for generation',
          'Implement proper retrieval strategies'
        ],
        structure: [
          'Separate ingestion, retrieval, and generation components',
          'Use proper data preprocessing pipelines',
          'Implement modular embedding strategies',
          'Design scalable vector storage'
        ],
        performance: [
          'Optimize vector similarity search',
          'Implement efficient chunking strategies',
          'Use proper caching for embeddings',
          'Optimize LLM inference'
        ]
      }
    },
    desktop: {
      native: {
        architecture: [
          'Use platform-specific frameworks (WPF, Cocoa, GTK)',
          'Implement proper MVVM or MVC patterns',
          'Use native UI controls and patterns',
          'Follow platform design guidelines'
        ],
        structure: [
          'Organize by application modules',
          'Separate UI from business logic',
          'Use proper data binding patterns',
          'Implement proper resource management'
        ],
        performance: [
          'Optimize for desktop performance',
          'Implement efficient memory usage',
          'Use proper threading for UI responsiveness',
          'Optimize startup time'
        ]
      },
      crossplatform: {
        architecture: [
          'Use Electron, Tauri, or Flutter Desktop',
          'Implement cross-platform abstractions',
          'Use web technologies for UI',
          'Maintain platform consistency'
        ],
        structure: [
          'Organize shared and platform-specific code',
          'Use proper IPC communication',
          'Implement platform-specific integrations',
          'Maintain consistent user experience'
        ],
        performance: [
          'Optimize bundle size and memory usage',
          'Use efficient rendering techniques',
          'Implement proper resource management',
          'Minimize platform overhead'
        ]
      }
    },
    cli: {
      tool: {
        architecture: [
          'Design intuitive command structure',
          'Implement proper argument parsing',
          'Use modular command architecture',
          'Follow CLI best practices'
        ],
        structure: [
          'Organize commands by functionality',
          'Separate command logic from execution',
          'Use proper configuration management',
          'Implement extensible plugin system'
        ],
        performance: [
          'Optimize startup time',
          'Implement efficient processing',
          'Use streaming for large data',
          'Minimize resource usage'
        ]
      }
    }
  };

  // Function to get guidelines based on application type and category
  const getGuidelinesForType = (applicationType: string, category: string) => {
    const typeMapping = guidelinesMapping[applicationType as keyof typeof guidelinesMapping];
    if (!typeMapping) return getDefaultGuidelines();

    const categoryMapping = typeMapping[category as keyof typeof typeMapping];
    if (!categoryMapping) return getDefaultGuidelines();

    return categoryMapping;
  };

  // Default guidelines fallback
  const getDefaultGuidelines = () => ({
    architecture: [
      'Follow established architectural patterns',
      'Implement proper separation of concerns',
      'Use appropriate design patterns',
      'Maintain code modularity and reusability'
    ],
    structure: [
      'Organize code in logical modules',
      'Separate business logic from presentation',
      'Use consistent naming conventions',
      'Implement proper error handling'
    ],
    performance: [
      'Optimize for target platform performance',
      'Implement efficient algorithms and data structures',
      'Use appropriate caching strategies',
      'Monitor and optimize resource usage'
    ]
  });

  const handleApplicationTypeChange = (value: string) => {
    const guidelines = newTemplate.category ?
      getGuidelinesForType(value, newTemplate.category) :
      getDefaultGuidelines();

    const additionalSections = getAdditionalSectionsForType(value, newTemplate.category);

    const updatedTemplate = {
      ...newTemplate,
      applicationType: value,
      guidelines: { ...guidelines },
      standards: { ...additionalSections.standards },
      libraries: { ...additionalSections.libraries },
      architecture: { ...additionalSections.architecture },
      // Auto-populate textarea fields with default content
      security: {
        authentication: additionalSections.security?.authentication?.join('\n') || 'Implement secure authentication flow\nUse JWT tokens with proper expiration\nImplement proper session management',
        dataProtection: additionalSections.security?.dataProtection?.join('\n') || 'Validate and sanitize user inputs\nImplement CSRF protection\nUse HTTPS for all communications',
        dependencies: additionalSections.security?.dependencies?.join('\n') || 'Regularly update dependencies\nUse npm audit for security vulnerabilities\nImplement dependency scanning in CI/CD'
      },
      performance: {
        optimization: additionalSections.performance?.optimization?.join('\n') || 'Implement code splitting at route level\nUse React.lazy for component lazy loading\nOptimize bundle size with tree shaking',
        monitoring: additionalSections.performance?.monitoring?.join('\n') || 'Use React DevTools for debugging\nImplement error tracking (Sentry)\nMonitor Core Web Vitals',
        loading: additionalSections.performance?.loading?.join('\n') || 'Implement loading states for async operations\nUse skeleton screens for better UX\nOptimize images with lazy loading'
      },
      testing: {
        unit: additionalSections.testing?.unit?.join('\n') || 'Use Jest and React Testing Library\nTest component behavior, not implementation\nAim for 80%+ code coverage',
        integration: additionalSections.testing?.integration?.join('\n') || 'Test user workflows and interactions\nTest API integrations\nUse MSW for API mocking',
        e2e: additionalSections.testing?.e2e?.join('\n') || 'Use Cypress or Playwright for E2E tests\nTest critical user journeys\nRun tests in CI/CD pipeline'
      },
      deployment: {
        build: additionalSections.deployment?.build?.join('\n') || 'Configure build optimization\nImplement environment-specific builds\nUse build caching for faster deployments',
        hosting: additionalSections.deployment?.hosting?.join('\n') || 'Deploy to Vercel, Netlify, or AWS\nConfigure proper redirects and rewrites\nSet up CDN for static assets',
        cicd: additionalSections.deployment?.cicd?.join('\n') || 'Set up automated testing in CI/CD\nImplement automated deployments\nUse feature flags for gradual rollouts'
      },
      precautions: {
        common_issues: additionalSections.precautions?.common_issues?.join('\n') || 'Avoid prop drilling - use Context or state management\nPrevent memory leaks with proper cleanup\nHandle edge cases and error states',
        performance_pitfalls: additionalSections.precautions?.performance_pitfalls?.join('\n') || 'Avoid unnecessary re-renders\nBe careful with useEffect dependencies\nOptimize expensive computations with useMemo',
        security_risks: additionalSections.precautions?.security_risks?.join('\n') || 'Validate all user inputs\nAvoid XSS vulnerabilities\nImplement proper authentication and authorization'
      }
    };

    setNewTemplate(updatedTemplate);
  };

  const handleCategoryChange = (value: string) => {
    const guidelines = newTemplate.applicationType ?
      getGuidelinesForType(newTemplate.applicationType, value) :
      getDefaultGuidelines();

    const additionalSections = getAdditionalSectionsForType(newTemplate.applicationType, value);

    const updatedTemplate = {
      ...newTemplate,
      category: value,
      guidelines: { ...guidelines },
      standards: { ...additionalSections.standards },
      libraries: { ...additionalSections.libraries },
      architecture: { ...additionalSections.architecture },
      // Auto-populate textarea fields with default content
      security: {
        authentication: additionalSections.security?.authentication?.join('\n') || 'Implement secure authentication flow\nUse JWT tokens with proper expiration\nImplement proper session management',
        dataProtection: additionalSections.security?.dataProtection?.join('\n') || 'Validate and sanitize user inputs\nImplement CSRF protection\nUse HTTPS for all communications',
        dependencies: additionalSections.security?.dependencies?.join('\n') || 'Regularly update dependencies\nUse npm audit for security vulnerabilities\nImplement dependency scanning in CI/CD'
      },
      performance: {
        optimization: additionalSections.performance?.optimization?.join('\n') || 'Implement code splitting at route level\nUse React.lazy for component lazy loading\nOptimize bundle size with tree shaking',
        monitoring: additionalSections.performance?.monitoring?.join('\n') || 'Use React DevTools for debugging\nImplement error tracking (Sentry)\nMonitor Core Web Vitals',
        loading: additionalSections.performance?.loading?.join('\n') || 'Implement loading states for async operations\nUse skeleton screens for better UX\nOptimize images with lazy loading'
      },
      testing: {
        unit: additionalSections.testing?.unit?.join('\n') || 'Use Jest and React Testing Library\nTest component behavior, not implementation\nAim for 80%+ code coverage',
        integration: additionalSections.testing?.integration?.join('\n') || 'Test user workflows and interactions\nTest API integrations\nUse MSW for API mocking',
        e2e: additionalSections.testing?.e2e?.join('\n') || 'Use Cypress or Playwright for E2E tests\nTest critical user journeys\nRun tests in CI/CD pipeline'
      },
      deployment: {
        build: additionalSections.deployment?.build?.join('\n') || 'Configure build optimization\nImplement environment-specific builds\nUse build caching for faster deployments',
        hosting: additionalSections.deployment?.hosting?.join('\n') || 'Deploy to Vercel, Netlify, or AWS\nConfigure proper redirects and rewrites\nSet up CDN for static assets',
        cicd: additionalSections.deployment?.cicd?.join('\n') || 'Set up automated testing in CI/CD\nImplement automated deployments\nUse feature flags for gradual rollouts'
      },
      precautions: {
        common_issues: additionalSections.precautions?.common_issues?.join('\n') || 'Avoid prop drilling - use Context or state management\nPrevent memory leaks with proper cleanup\nHandle edge cases and error states',
        performance_pitfalls: additionalSections.precautions?.performance_pitfalls?.join('\n') || 'Avoid unnecessary re-renders\nBe careful with useEffect dependencies\nOptimize expensive computations with useMemo',
        security_risks: additionalSections.precautions?.security_risks?.join('\n') || 'Validate all user inputs\nAvoid XSS vulnerabilities\nImplement proper authentication and authorization'
      }
    };

    setNewTemplate(updatedTemplate);
  };

  // Function to get additional template sections based on type and category
  const getAdditionalSectionsForType = (applicationType: string, category: string) => {
    if (!applicationType || !category) {
      return getDefaultAdditionalSections();
    }

    const typeMapping = guidelinesMapping[applicationType as keyof typeof guidelinesMapping];
    if (!typeMapping) {
      return getDefaultAdditionalSections();
    }

    const categoryMapping = typeMapping[category as keyof typeof typeMapping];
    if (!categoryMapping) {
      return getDefaultAdditionalSections();
    }

    // Return comprehensive sections based on the seeded template structure
    if (applicationType === 'web' && category === 'frontend') {
      return {
        standards: {
          naming: [
            'Use PascalCase for component names',
            'Use camelCase for variables and functions',
            'Use kebab-case for file names',
            'Use descriptive and meaningful names'
          ],
          formatting: [
            'Use Prettier for code formatting',
            'Configure ESLint for code quality',
            'Use consistent indentation (2 spaces)',
            'Follow JSX formatting conventions'
          ],
          documentation: [
            'Document component props with TypeScript interfaces',
            'Add JSDoc comments for complex functions',
            'Maintain up-to-date README documentation',
            'Document API integrations and data flow'
          ]
        },
        libraries: {
          core: [
            'React 18+ with TypeScript',
            'React Router for navigation',
            'React Query or SWR for data fetching',
            'Zustand or Redux Toolkit for state management'
          ],
          ui: [
            'Tailwind CSS or Styled Components for styling',
            'Headless UI or Radix UI for accessible components',
            'React Hook Form for form handling',
            'Framer Motion for animations'
          ],
          utilities: [
            'Axios for HTTP requests',
            'Date-fns or Day.js for date manipulation',
            'Lodash for utility functions',
            'React Hot Toast for notifications'
          ]
        },
        architecture: {
          patterns: [
            'Component-based architecture',
            'Container/Presentational component pattern',
            'Custom hooks pattern',
            'Compound component pattern'
          ],
          dataFlow: [
            'Unidirectional data flow',
            'Props down, events up pattern',
            'Context for global state',
            'Server state vs client state separation'
          ],
          routing: [
            'File-based or declarative routing',
            'Protected routes for authentication',
            'Lazy loading for route components',
            'Proper error handling for routes'
          ]
        }
      };
    }

    if (applicationType === 'web' && category === 'fullstack') {
      return {
        standards: {
          naming: [
            'Use consistent naming across frontend and backend',
            'Follow framework-specific conventions',
            'Use descriptive API endpoint names',
            'Maintain consistent file naming'
          ],
          formatting: [
            'Use Prettier for both frontend and backend',
            'Configure ESLint for full-stack consistency',
            'Use consistent indentation across projects',
            'Follow framework formatting conventions'
          ],
          documentation: [
            'Document API endpoints with OpenAPI',
            'Maintain component and function documentation',
            'Document database schema and migrations',
            'Keep deployment and setup documentation updated'
          ]
        },
        libraries: {
          core: [
            'Next.js or Nuxt.js for full-stack framework',
            'TypeScript for type safety across stack',
            'Database ORM (Prisma, Drizzle)',
            'Authentication library (NextAuth, Supabase)'
          ],
          ui: [
            'Tailwind CSS for styling',
            'Component library (Radix, Headless UI)',
            'Form handling (React Hook Form)',
            'State management (Zustand, Redux Toolkit)'
          ],
          utilities: [
            'Validation library (Zod, Yup)',
            'Date manipulation (date-fns)',
            'HTTP client (Axios, fetch)',
            'Environment configuration (dotenv)'
          ]
        },
        architecture: {
          patterns: [
            'Full-stack monorepo or separate repos',
            'API-first design approach',
            'Shared type definitions',
            'Microservices or monolithic architecture'
          ],
          dataFlow: [
            'Client-server communication patterns',
            'Database to API to frontend flow',
            'Real-time updates (WebSockets, SSE)',
            'Caching strategies across layers'
          ],
          routing: [
            'File-based routing (Next.js style)',
            'API route organization',
            'Protected routes and middleware',
            'SEO-friendly routing'
          ]
        }
      };
    }

    if (applicationType === 'api' && category === 'backend') {
      return {
        standards: {
          naming: [
            'Use camelCase for variables and functions',
            'Use PascalCase for classes and interfaces',
            'Use kebab-case for file names',
            'Use descriptive and meaningful names'
          ],
          formatting: [
            'Use Prettier for code formatting',
            'Configure ESLint with TypeScript rules',
            'Use consistent indentation (2 spaces)',
            'Follow consistent import ordering'
          ],
          documentation: [
            'Use OpenAPI/Swagger for API documentation',
            'Document all endpoints with examples',
            'Maintain up-to-date README',
            'Document environment variables and setup'
          ]
        },
        libraries: {
          core: [
            'Node.js 18+ with TypeScript',
            'Express.js for web framework',
            'Helmet for security headers',
            'CORS for cross-origin requests'
          ],
          ui: [
            'Prisma or TypeORM for database ORM',
            'PostgreSQL or MongoDB for database',
            'Redis for caching and sessions',
            'Database migration tools'
          ],
          utilities: [
            'Joi or Zod for validation',
            'Winston for logging',
            'Dotenv for environment variables',
            'Bcrypt for password hashing'
          ]
        },
        architecture: {
          patterns: [
            'MVC or Clean Architecture',
            'Repository pattern for data access',
            'Service layer for business logic',
            'Middleware pattern for request processing'
          ],
          dataFlow: [
            'Request → Middleware → Controller → Service → Repository',
            'Proper error propagation',
            'Response formatting and standardization',
            'Input validation and sanitization'
          ],
          routing: [
            'RESTful API endpoints',
            'Proper HTTP status codes',
            'API versioning strategy',
            'Rate limiting and throttling'
          ]
        }
      };
    }

    // Add more combinations dynamically based on the guidelines mapping
    return {
      standards: {
        naming: [
          `Use ${applicationType}-specific naming conventions`,
          'Follow industry best practices',
          'Use descriptive and meaningful names',
          'Maintain consistency across codebase'
        ],
        formatting: [
          'Use appropriate code formatting tools',
          'Configure linting for code quality',
          'Follow language/framework conventions',
          'Maintain consistent style guide'
        ],
        documentation: [
          'Document public APIs and interfaces',
          'Maintain comprehensive README',
          'Add inline comments for complex logic',
          'Document setup and deployment processes'
        ]
      },
      libraries: {
        core: [
          `Use modern ${applicationType} frameworks`,
          'Choose stable, well-maintained libraries',
          'Consider performance implications',
          'Maintain security updates'
        ],
        ui: [
          `Use appropriate ${category} UI libraries`,
          'Follow accessibility guidelines',
          'Implement responsive design patterns',
          'Use consistent design system'
        ],
        utilities: [
          'Use utility libraries judiciously',
          'Prefer native implementations when possible',
          'Consider bundle size impact',
          'Maintain dependency security'
        ]
      },
      architecture: {
        patterns: [
          `Follow ${applicationType} architectural patterns`,
          'Implement proper separation of concerns',
          'Use appropriate design patterns',
          'Maintain modularity and reusability'
        ],
        dataFlow: [
          `Design clear ${category} data flow`,
          'Implement proper state management',
          'Handle errors gracefully',
          'Maintain data consistency'
        ],
        routing: [
          `Implement ${applicationType} routing patterns`,
          'Handle navigation appropriately',
          'Implement proper error handling',
          'Consider performance implications'
        ]
      }
    };
  };

  // Default additional sections fallback
  const getDefaultAdditionalSections = () => ({
    standards: {
      naming: [
        'Use consistent naming conventions',
        'Follow language-specific conventions',
        'Use descriptive and meaningful names',
        'Avoid abbreviations and acronyms'
      ],
      formatting: [
        'Use consistent code formatting',
        'Configure linting tools',
        'Follow indentation standards',
        'Maintain consistent style'
      ],
      documentation: [
        'Document public APIs and interfaces',
        'Maintain up-to-date README',
        'Add inline comments for complex logic',
        'Document setup and deployment'
      ]
    },
    libraries: {
      core: [
        'Choose stable, well-maintained libraries',
        'Use appropriate framework for the platform',
        'Consider performance implications',
        'Maintain dependency versions'
      ],
      ui: [
        'Use appropriate UI framework',
        'Follow accessibility guidelines',
        'Implement responsive design',
        'Use consistent design system'
      ],
      utilities: [
        'Use utility libraries judiciously',
        'Prefer native implementations when possible',
        'Consider bundle size impact',
        'Maintain security updates'
      ]
    },
    architecture: {
      patterns: [
        'Follow established architectural patterns',
        'Implement proper separation of concerns',
        'Use appropriate design patterns',
        'Maintain modularity and reusability'
      ],
      dataFlow: [
        'Design clear data flow patterns',
        'Implement proper state management',
        'Handle errors gracefully',
        'Maintain data consistency'
      ],
      routing: [
        'Implement clear navigation patterns',
        'Handle deep linking appropriately',
        'Implement proper error pages',
        'Consider SEO implications'
      ]
    }
  });

  const creatingTemplateModal = () => {
    const isEditing = editingTemplate !== null;

    const handleSave = async () => {
      if (isEditing) {
        await updateTemplate();
      } else {
        await createTemplate();
      }
    };

    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
        <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] overflow-hidden">
          <div className="flex justify-between items-center p-6 border-b">
            <h2 className="text-xl font-semibold">{isEditing ? 'Edit Template' : 'Create New Template'}</h2>
            <Button
              variant="outline"
              onClick={() => {
                setCreatingTemplate(false);
                setEditingTemplate(null);
              }}
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
          <div className="p-6 overflow-y-auto max-h-[calc(90vh-120px)]">
            <div className="space-y-6">

              {/* Basic Information */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Template Name *</label>
                  <Input
                    value={newTemplate.name}
                    onChange={(e) => setNewTemplate({ ...newTemplate, name: e.target.value })}
                    placeholder="Enter template name..."
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Tags (comma-separated)</label>
                  <Input
                    value={newTemplate.tags.join(', ')}
                    onChange={(e) => {
                      setNewTemplate({
                        ...newTemplate,
                        tags: e.target.value.split(',').map(tag => tag.trim()).filter(tag => tag)
                      });
                    }}
                    placeholder="react, typescript, api..."
                    className="w-full"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Description</label>
                <textarea
                  value={newTemplate.description}
                  onChange={(e) => setNewTemplate({ ...newTemplate, description: e.target.value })}
                  placeholder="Describe this template..."
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Application Type</label>
                  <select
                    value={newTemplate.applicationType}
                    onChange={(e) => handleApplicationTypeChange(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                  >
                    <option value="">Select type...</option>
                    {metadata?.applicationTypes.map(type => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Category</label>
                  <select
                    value={newTemplate.category}
                    onChange={(e) => handleCategoryChange(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                  >
                    <option value="">Select category...</option>
                    {metadata?.categories.map(category => (
                      <option key={category} value={category}>{category}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Security */}
              <div>
                <h3 className="text-lg font-medium text-gray-900 mb-3">Security</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Authentication (one per line)</label>
                    <textarea
                      value={newTemplate.security?.authentication || ''}
                      onChange={(e) => {
                        setNewTemplate({
                          ...newTemplate,
                          security: {
                            ...newTemplate.security || {},
                            authentication: e.target.value
                          }
                        });
                      }}
                      placeholder="Implement secure authentication flow&#10;Use JWT tokens with proper expiration"
                      rows={4}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Data Protection (one per line)</label>
                    <textarea
                      value={newTemplate.security?.dataProtection || ''}
                      onChange={(e) => {
                        setNewTemplate({
                          ...newTemplate,
                          security: {
                            ...newTemplate.security || {},
                            dataProtection: e.target.value
                          }
                        });
                      }}
                      placeholder="Validate and sanitize user inputs&#10;Implement CSRF protection"
                      rows={4}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Dependencies (one per line)</label>
                    <textarea
                      value={newTemplate.security?.dependencies || ''}
                      onChange={(e) => {
                        setNewTemplate({
                          ...newTemplate,
                          security: {
                            ...newTemplate.security || {},
                            dependencies: e.target.value
                          }
                        });
                      }}
                      placeholder="Regularly update dependencies&#10;Use npm audit for security vulnerabilities"
                      rows={4}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                    />
                  </div>
                </div>
              </div>

              {/* Performance */}
              <div>
                <h3 className="text-lg font-medium text-gray-900 mb-3">Performance</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Optimization (one per line)</label>
                    <textarea
                      value={newTemplate.performance?.optimization || ''}
                      onChange={(e) => {
                        setNewTemplate({
                          ...newTemplate,
                          performance: {
                            ...newTemplate.performance || {},
                            optimization: e.target.value
                          }
                        });
                      }}
                      placeholder="Implement code splitting at route level&#10;Use React.lazy for component lazy loading"
                      rows={4}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Monitoring (one per line)</label>
                    <textarea
                      value={newTemplate.performance?.monitoring || ''}
                      onChange={(e) => {
                        setNewTemplate({
                          ...newTemplate,
                          performance: {
                            ...newTemplate.performance || {},
                            monitoring: e.target.value
                          }
                        });
                      }}
                      placeholder="Use React DevTools for debugging&#10;Implement error tracking (Sentry)"
                      rows={4}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Loading (one per line)</label>
                    <textarea
                      value={newTemplate.performance?.loading || ''}
                      onChange={(e) => {
                        setNewTemplate({
                          ...newTemplate,
                          performance: {
                            ...newTemplate.performance || {},
                            loading: e.target.value
                          }
                        });
                      }}
                      placeholder="Implement loading states for async operations&#10;Use skeleton screens for better UX"
                      rows={4}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                    />
                  </div>
                </div>
              </div>

              {/* Testing */}
              <div>
                <h3 className="text-lg font-medium text-gray-900 mb-3">Testing</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Unit Testing (one per line)</label>
                    <textarea
                      value={newTemplate.testing?.unit || ''}
                      onChange={(e) => {
                        setNewTemplate({
                          ...newTemplate,
                          testing: {
                            ...newTemplate.testing || {},
                            unit: e.target.value
                          }
                        });
                      }}
                      placeholder="Use Jest and React Testing Library&#10;Test component behavior, not implementation"
                      rows={4}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Integration Testing (one per line)</label>
                    <textarea
                      value={newTemplate.testing?.integration || ''}
                      onChange={(e) => {
                        setNewTemplate({
                          ...newTemplate,
                          testing: {
                            ...newTemplate.testing || {},
                            integration: e.target.value
                          }
                        });
                      }}
                      placeholder="Test user workflows and interactions&#10;Test API integrations"
                      rows={4}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">E2E Testing (one per line)</label>
                    <textarea
                      value={newTemplate.testing?.e2e || ''}
                      onChange={(e) => {
                        setNewTemplate({
                          ...newTemplate,
                          testing: {
                            ...newTemplate.testing || {},
                            e2e: e.target.value
                          }
                        });
                      }}
                      placeholder="Use Cypress or Playwright for E2E tests&#10;Test critical user journeys"
                      rows={4}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                    />
                  </div>
                </div>
              </div>

              {/* Deployment */}
              <div>
                <h3 className="text-lg font-medium text-gray-900 mb-3">Deployment</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Build (one per line)</label>
                    <textarea
                      value={newTemplate.deployment?.build || ''}
                      onChange={(e) => {
                        setNewTemplate({
                          ...newTemplate,
                          deployment: {
                            ...newTemplate.deployment || {},
                            build: e.target.value
                          }
                        });
                      }}
                      placeholder="Configure build optimization&#10;Implement environment-specific builds"
                      rows={4}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Hosting (one per line)</label>
                    <textarea
                      value={newTemplate.deployment?.hosting || ''}
                      onChange={(e) => {
                        setNewTemplate({
                          ...newTemplate,
                          deployment: {
                            ...newTemplate.deployment || {},
                            hosting: e.target.value
                          }
                        });
                      }}
                      placeholder="Deploy to Vercel, Netlify, or AWS&#10;Configure proper redirects and rewrites"
                      rows={4}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">CI/CD (one per line)</label>
                    <textarea
                      value={newTemplate.deployment?.cicd || ''}
                      onChange={(e) => {
                        setNewTemplate({
                          ...newTemplate,
                          deployment: {
                            ...newTemplate.deployment || {},
                            cicd: e.target.value
                          }
                        });
                      }}
                      placeholder="Set up automated testing in CI/CD&#10;Implement automated deployments"
                      rows={4}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                    />
                  </div>
                </div>
              </div>

              {/* Precautions */}
              <div>
                <h3 className="text-lg font-medium text-gray-900 mb-3">Precautions</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Common Issues (one per line)</label>
                    <textarea
                      value={newTemplate.precautions?.common_issues || ''}
                      onChange={(e) => {
                        setNewTemplate({
                          ...newTemplate,
                          precautions: {
                            ...newTemplate.precautions || {},
                            common_issues: e.target.value
                          }
                        });
                      }}
                      placeholder="Avoid prop drilling - use Context or state management&#10;Prevent memory leaks with proper cleanup"
                      rows={4}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Performance Pitfalls (one per line)</label>
                    <textarea
                      value={newTemplate.precautions?.performance_pitfalls || ''}
                      onChange={(e) => {
                        setNewTemplate({
                          ...newTemplate,
                          precautions: {
                            ...newTemplate.precautions || {},
                            performance_pitfalls: e.target.value
                          }
                        });
                      }}
                      placeholder="Avoid unnecessary re-renders&#10;Be careful with useEffect dependencies"
                      rows={4}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Security Risks (one per line)</label>
                    <textarea
                      value={newTemplate.precautions?.security_risks || ''}
                      onChange={(e) => {
                        setNewTemplate({
                          ...newTemplate,
                          precautions: {
                            ...newTemplate.precautions || {},
                            security_risks: e.target.value
                          }
                        });
                      }}
                      placeholder="Validate all user inputs&#10;Avoid XSS vulnerabilities"
                      rows={4}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                    />
                  </div>
                </div>
              </div>

            </div>
          </div>
          <div className="flex justify-end gap-2 p-6 border-t">
            <Button
              variant="outline"
              onClick={() => {
                setCreatingTemplate(false);
                setEditingTemplate(null);
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={!newTemplate.name.trim()}>
              {isEditing ? 'Update Template' : 'Create Template'}
            </Button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Prompt Builder</h1>
          <p className="text-gray-600 mt-2">
            Create and manage AI development prompts for various application types
          </p>
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-200 mb-8">
          <nav className="-mb-px flex space-x-8">
            <button
              onClick={() => setActiveTab('templates')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${activeTab === 'templates'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
            >
              <FileText className="w-4 h-4 inline mr-2" />
              Templates
            </button>
            <button
              onClick={() => setActiveTab('sessions')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${activeTab === 'sessions'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
            >
              <Clock className="w-4 h-4 inline mr-2" />
              Generated Prompts
            </button>
            <button
              onClick={() => setActiveTab('generate')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${activeTab === 'generate'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
            >
              <Zap className="w-4 h-4 inline mr-2" />
              Generate New
            </button>
            <button
              onClick={() => setActiveTab('build')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${activeTab === 'build'
                ? 'border-indigo-500 text-indigo-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
            >
              <Rocket className="w-4 h-4 inline mr-2" />
              Build
            </button>
          </nav>
        </div>

        {/* Tab Content */}
        {activeTab === 'templates' && renderTemplatesTab()}
        {activeTab === 'sessions' && renderSessionsTab()}
        {activeTab === 'generate' && renderGenerateTab()}
        {activeTab === 'build' && renderBuildTab()}

        {/* Template View Modal */}
        {viewingTemplate && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] overflow-hidden">
              <div className="flex justify-between items-center p-6 border-b">
                <h2 className="text-xl font-semibold">{viewingTemplate.name}</h2>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => copyTemplateContent(viewingTemplate)}
                  >
                    <Copy className="w-4 h-4 mr-2" />
                    Copy
                  </Button>
                  <Button
                    variant="outline"
                    onClick={closeTemplateView}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </div>
              <div className="p-6 overflow-y-auto max-h-[calc(90vh-120px)]">
                <div className="space-y-6">
                  <div>
                    <h3 className="font-medium text-gray-900 mb-2">Description</h3>
                    <p className="text-gray-600">{viewingTemplate.description}</p>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <h3 className="font-medium text-gray-900 mb-2">Application Type</h3>
                      <span className="px-2 py-1 bg-blue-100 text-blue-800 text-sm rounded-full">
                        {viewingTemplate.applicationType}
                      </span>
                    </div>
                    <div>
                      <h3 className="font-medium text-gray-900 mb-2">Category</h3>
                      <span className="px-2 py-1 bg-green-100 text-green-800 text-sm rounded-full">
                        {viewingTemplate.category}
                      </span>
                    </div>
                  </div>

                  <div>
                    <h3 className="font-medium text-gray-900 mb-2">Tags</h3>
                    <div className="flex flex-wrap gap-2">
                      {viewingTemplate.tags?.map(tag => (
                        <span key={tag} className="px-2 py-1 bg-gray-100 text-gray-800 text-sm rounded-full">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div>
                    <h3 className="font-medium text-gray-900 mb-2">Architecture</h3>
                    <div className="bg-gray-50 p-4 rounded-lg">
                      <pre className="text-sm text-gray-600 whitespace-pre-wrap">
                        {typeof viewingTemplate.architecture === 'string'
                          ? viewingTemplate.architecture
                          : JSON.stringify(viewingTemplate.architecture, null, 2)
                        }
                      </pre>
                    </div>
                  </div>

                  {Object.entries({
                    'Guidelines': viewingTemplate.guidelines,
                    'Standards': viewingTemplate.standards,
                    'Libraries': viewingTemplate.libraries,
                    'Security': viewingTemplate.security,
                    'Performance': viewingTemplate.performance,
                    'Testing': viewingTemplate.testing,
                    'Deployment': viewingTemplate.deployment,
                    'Precautions': viewingTemplate.precautions
                  }).map(([key, value]) => (
                    value && (
                      <div key={key}>
                        <h3 className="font-medium text-gray-900 mb-2">{key}</h3>
                        <div className="bg-gray-50 p-4 rounded-lg">
                          <pre className="text-sm text-gray-600 whitespace-pre-wrap">
                            {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
                          </pre>
                        </div>
                      </div>
                    )
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Session Viewing Modal */}
        {viewingSession && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] overflow-hidden">
              <div className="p-6 border-b border-gray-200">
                <div className="flex justify-between items-center">
                  <h3 className="text-lg font-semibold">
                    {viewingSession.template?.name || 'Unknown Template'}
                  </h3>
                  <div className="flex gap-2">
                    {!editingPrompt ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setEditingPrompt(true);
                          setEditedPromptText(viewingSession.generatedPrompt);
                        }}
                      >
                        <Edit className="w-4 h-4 mr-1" />
                        Edit
                      </Button>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={savingPrompt}
                          onClick={() => {
                            setEditingPrompt(false);
                            setEditedPromptText(viewingSession.generatedPrompt);
                          }}
                        >
                          <X className="w-4 h-4 mr-1" />
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          disabled={savingPrompt}
                          onClick={() => updateSession(viewingSession.id, editedPromptText)}
                          className="bg-green-600 hover:bg-green-700 text-white"
                        >
                          {savingPrompt ? (
                            <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                          ) : (
                            <Save className="w-4 h-4 mr-1" />
                          )}
                          Save
                        </Button>
                      </>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setViewingSession(null);
                        setEditingPrompt(false);
                      }}
                    >
                      Close
                    </Button>
                  </div>
                </div>
              </div>
              <div className="p-6 overflow-y-auto max-h-[calc(90vh-120px)]">
                <div className="space-y-4 mb-6">
                  <div>
                    <h4 className="font-medium text-gray-900 mb-2">Project Description</h4>
                    <p className="text-gray-700">{viewingSession.projectDescription}</p>
                  </div>
                  {viewingSession.selectedFeatures.length > 0 && (
                    <div>
                      <h4 className="font-medium text-gray-900 mb-2">Selected Features</h4>
                      <ul className="list-disc list-inside text-gray-700">
                        {viewingSession.selectedFeatures.map((feature, index) => (
                          <li key={index}>{feature}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {viewingSession.customRequirements.length > 0 && (
                    <div>
                      <h4 className="font-medium text-gray-900 mb-2">Custom Requirements</h4>
                      <ul className="list-disc list-inside text-gray-700">
                        {viewingSession.customRequirements.map((req, index) => (
                          <li key={index}>{req}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
                <div>
                  <h4 className="font-medium text-gray-900 mb-2">Generated Prompt</h4>
                  {editingPrompt ? (
                    <textarea
                      value={editedPromptText}
                      onChange={(e) => setEditedPromptText(e.target.value)}
                      className="w-full h-96 p-4 border border-gray-300 rounded-md font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  ) : (
                    <div className="bg-gray-50 rounded-md p-4">
                      <pre className="whitespace-pre-wrap text-sm text-gray-800">
                        {viewingSession.generatedPrompt}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* GitHub Push Modal */}
        {showGitHubModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-lg max-w-lg w-full">
              <div className="p-6 border-b border-gray-200">
                <div className="flex justify-between items-center">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    <GitBranch className="w-5 h-5" />
                    Push Prompts to GitHub
                  </h3>
                  <Button size="sm" variant="outline" onClick={() => setShowGitHubModal(false)}>
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </div>
              <div className="p-6 space-y-4">
                <p className="text-sm text-gray-600">
                  Pushing {gitHubPushType === 'templates' ? selectedTemplates.size : selectedSessions.size} {gitHubPushType === 'templates' ? 'template(s)' : 'prompt(s)'} to GitHub
                </p>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Repository</label>
                  <select
                    value={selectedRepo}
                    onChange={(e) => handleRepoChange(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">Select a repository...</option>
                    {repos.map((repo: any) => (
                      <option key={repo.full_name} value={repo.full_name}>
                        {repo.full_name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Branch</label>
                  <select
                    value={selectedBranch}
                    onChange={(e) => setSelectedBranch(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {branches.length > 0 ? (
                      branches.map((b: string) => (
                        <option key={b} value={b}>{b}</option>
                      ))
                    ) : (
                      <option value="main">main</option>
                    )}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Folder Path</label>
                  <Input
                    value={pushPath}
                    onChange={(e) => setPushPath(e.target.value)}
                    placeholder="prompts"
                  />
                </div>

                <Button
                  onClick={pushToGitHub}
                  disabled={!selectedRepo || pushing}
                  className="w-full bg-gray-900 hover:bg-gray-800 text-white"
                >
                  {pushing ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Pushing...
                    </>
                  ) : (
                    <>
                      <GitBranch className="w-4 h-4 mr-2" />
                      Push {gitHubPushType === 'templates' ? selectedTemplates.size : selectedSessions.size} {gitHubPushType === 'templates' ? 'Template(s)' : 'Prompt(s)'}
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Template Creation Modal */}
        {creatingTemplate && creatingTemplateModal()}
      </div>
    </div>
  );
};

export default PromptBuilderPage;
