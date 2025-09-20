import axios from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

export const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add auth token to requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle auth errors
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// API functions
export const authAPI = {
  login: (email: string, password: string) =>
    api.post('/auth/login', { email, password }),
  register: (username: string, email: string, password: string) =>
    api.post('/auth/register', { username, email, password }),
  me: () => api.get('/auth/me'),
};

export const projectsAPI = {
  list: () => api.get('/projects'),
  create: (data: { title: string; description?: string; requirements?: string }) =>
    api.post('/projects', data),
  getPlans: (projectId: string) => api.get(`/projects/${projectId}/plans`),
};

export const mvpAPI = {
  generate: (data: {
    projectId: string;
    requirements: string;
    projectTitle: string;
    provider: string;
    planType?: string;
  }) => api.post('/generate-mvp', data),
  getProviders: () => api.get('/providers'),
};

export const filesAPI = {
  upload: (file: File, projectId?: string) => {
    const formData = new FormData();
    formData.append('file', file);
    if (projectId) {
      formData.append('projectId', projectId);
    }
    return api.post('/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
  },
};

// API Keys API
export const apiKeysAPI = {
  getAll: async () => {
    const response = await api.get('/api-keys');
    return response.data;
  },

  create: async (data: { provider: string; name?: string; key: string }) => {
    const response = await api.post('/api-keys', data);
    return response.data;
  },

  delete: async (id: string) => {
    const response = await api.delete(`/api-keys/${id}`);
    return response.data;
  },

  update: async (id: string, data: { name?: string; isActive?: boolean }) => {
    const response = await api.patch(`/api-keys/${id}`, data);
    return response.data;
  },
};

// Chat API
export const chatAPI = {
  getMessages: async (projectId?: number) => {
    const url = projectId ? `/chat/messages?projectId=${projectId}` : '/chat/messages';
    const response = await api.get(url);
    return response.data;
  },

  sendMessage: async (data: { 
    content: string; 
    provider: string; 
    projectId?: number;
  }) => {
    const response = await api.post('/chat/messages', data);
    return response.data;
  },

  clearHistory: async (projectId?: number) => {
    const url = projectId ? `/chat/messages?projectId=${projectId}` : '/chat/messages';
    const response = await api.delete(url);
    return response.data;
  },

  deleteMessage: async (id: number) => {
    const response = await api.delete(`/chat/messages/${id}`);
    return response.data;
  },
};

// Chat Templates API
export const chatTemplatesAPI = {
  list: async (category?: string) => {
    const url = category ? `/chat/templates?category=${category}` : '/chat/templates';
    const response = await api.get(url);
    return response.data;
  },

  create: async (data: {
    name: string;
    description: string;
    content: string;
    category: string;
    tags: string[];
    isPublic?: boolean;
  }) => {
    const response = await api.post('/chat/templates', data);
    return response.data;
  },

  update: async (id: number, data: {
    name: string;
    description: string;
    content: string;
    category: string;
    tags: string[];
    isPublic?: boolean;
  }) => {
    const response = await api.put(`/chat/templates/${id}`, data);
    return response.data;
  },

  delete: async (id: number) => {
    const response = await api.delete(`/chat/templates/${id}`);
    return response.data;
  },
};

// Document Generation API
export const documentsAPI = {
  generate: async (data: {
    projectId: string;
    requirements: string;
    projectTitle: string;
    provider: string;
    documentType: string;
    estimationSettingsId?: string;
  }) => {
    const response = await api.post('/generate-document', data);
    return response.data;
  },

  generateBatch: async (data: {
    projectId: string;
    requirements: string;
    projectTitle: string;
    provider: string;
    documentTypes: string[];
    estimationSettingsId?: string;
  }) => {
    const response = await api.post('/generate-documents-batch', data);
    return response.data;
  },

  getProjectDocuments: async (projectId: string) => {
    const response = await api.get(`/projects/${projectId}/documents`);
    return response.data;
  },
};

export const estimationSettingsAPI = {
  list: () => api.get('/estimation-settings'),
  create: (data: {
    name: string;
    description?: string;
    complexityWeights: any;
    functionTypes: any;
    environmentalFactors: any;
    projectParameters: any;
    isDefault?: boolean;
  }) => api.post('/estimation-settings', data),
  update: (id: string, data: {
    name: string;
    description?: string;
    complexityWeights: any;
    functionTypes: any;
    environmentalFactors: any;
    projectParameters: any;
    isDefault?: boolean;
  }) => api.put(`/estimation-settings/${id}`, data),
  delete: (id: string) => api.delete(`/estimation-settings/${id}`)
};
