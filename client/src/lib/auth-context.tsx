import React, { createContext, useContext, useState, useEffect } from 'react';
import { api } from './api';

interface User {
  id: string;
  username: string;
  email: string;
}

interface AuthContextType {
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  loginWithMicrosoft: () => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
  logout: () => void;
  loading: boolean;
  microsoftEnabled: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [microsoftEnabled, setMicrosoftEnabled] = useState(false);

  useEffect(() => {
    checkAuth();
    checkMicrosoftStatus();
  }, []);

  // Handle auth callback from URL (Microsoft SSO redirect)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (token && window.location.pathname === '/auth/callback') {
      localStorage.setItem('token', token);
      const redirect = params.get('redirect') || '/dashboard';
      // Clean up URL and redirect
      window.history.replaceState({}, '', redirect);
      checkAuth();
    }
  }, []);

  const checkAuth = async () => {
    try {
      const token = localStorage.getItem('token');
      if (token) {
        const response = await api.get('/auth/me');
        setUser(response.data.user);
      }
    } catch (error) {
      localStorage.removeItem('token');
    } finally {
      setLoading(false);
    }
  };

  const checkMicrosoftStatus = async () => {
    try {
      const response = await api.get('/auth/microsoft/status');
      setMicrosoftEnabled(response.data.configured);
    } catch {
      // Microsoft auth not available
      setMicrosoftEnabled(false);
    }
  };

  const login = async (email: string, password: string) => {
    const response = await api.post('/auth/login', { email, password });
    const { token, user } = response.data;
    localStorage.setItem('token', token);
    setUser(user);
  };

  const loginWithMicrosoft = async () => {
    try {
      const response = await api.get('/auth/microsoft/login');
      // Redirect to Microsoft login page
      window.location.href = response.data.authUrl;
    } catch (error: any) {
      throw new Error(error.response?.data?.error || 'Microsoft sign-in is not available');
    }
  };

  const register = async (username: string, email: string, password: string) => {
    await api.post('/auth/register', { username, email, password });
    await login(email, password);
  };

  const logout = () => {
    localStorage.removeItem('token');
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, login, loginWithMicrosoft, register, logout, loading, microsoftEnabled }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
