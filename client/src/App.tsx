import React from 'react';
import { Router, Route, Switch, useLocation } from 'wouter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/lib/auth-context';
import Layout from '@/components/Layout';
import Navbar from '@/components/Navbar';
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import HomePage from '@/pages/HomePage';
import LoginPage from '@/pages/LoginPage';
import RegisterPage from '@/pages/RegisterPage';
import DashboardPage from '@/pages/DashboardPage';
import GeneratePage from '@/pages/GeneratePage';
import ProjectsPage from '@/pages/ProjectsPage';
import ProjectsListPage from '@/pages/ProjectsListPage';
import ProjectDocumentsPage from '@/pages/ProjectDocumentsPage';
import EstimationSettingsPage from '@/pages/EstimationSettingsPage';
import NotFoundPage from '@/pages/NotFoundPage';
import ApiKeySettings from '@/components/ApiKeySettings';
import Chat from '@/components/Chat';
import PromptBuilderPage from './pages/PromptBuilderPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function App() {
  const [location] = useLocation();
  const isAuthPage = location === '/login' || location === '/register';

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <Router>
            <Layout>
              {!isAuthPage && <Navbar />}
              <main className={isAuthPage ? '' : 'pt-16'}>
                <Switch>
                  <Route path="/login" component={LoginPage} />
                  <Route path="/register" component={RegisterPage} />
                  <Route path="/" component={DashboardPage} />
                  <Route path="/dashboard" component={DashboardPage} />
                  <Route path="/generate" component={GeneratePage} />
                  <Route path="/projects" component={ProjectsListPage} />
                  <Route path="/projects/:projectId/documents" component={ProjectDocumentsPage} />
                  <Route path="/projects/:projectId" component={ProjectsPage} />
                  <Route path="/settings" component={ApiKeySettings} />
                  <Route path="/estimation-settings" component={EstimationSettingsPage} />
                  <Route path="/prompt-builder" component={PromptBuilderPage} />
                  <Route path="/chat" component={Chat} />
                  <Route component={NotFoundPage} />
                </Switch>
              </main>
            </Layout>
          </Router>
        </TooltipProvider>
        <Toaster />
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
