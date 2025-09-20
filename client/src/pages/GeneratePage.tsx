import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import FileUpload from '@/components/FileUpload';
import DocumentGenerator from '@/components/DocumentGenerator';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/lib/auth-context';
import { projectsAPI, mvpAPI, filesAPI } from '@/lib/api';
import { 
  ArrowLeft, 
  ArrowRight, 
  Sparkles, 
  FileText,
  Settings,
  Zap,
  Loader2,
  CheckCircle
} from 'lucide-react';

interface ProjectData {
  title: string;
  description: string;
  files: File[];
  provider: string;
  requirements: string;
}

export default function GeneratePage() {
  const [currentStep, setCurrentStep] = useState(1);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedPlan, setGeneratedPlan] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const { toast } = useToast();
  const { user, loading } = useAuth();
  const [projectData, setProjectData] = useState<ProjectData>({
    title: '',
    description: '',
    files: [],
    provider: 'openai',
    requirements: ''
  });

  const handleFileSelect = (files: File[]) => {
    setProjectData(prev => ({ ...prev, files }));
  };

  const nextStep = () => {
    if (currentStep < 4) setCurrentStep(currentStep + 1); // Updated to 4 steps
  };

  const prevStep = () => {
    if (currentStep > 1) setCurrentStep(currentStep - 1);
  };

  const handleProjectSubmit = async () => {
    if (!projectData.title.trim()) {
      toast({
        title: "Missing Information",
        description: "Please provide a project title.",
        variant: "destructive",
      });
      return;
    }

    try {
      setIsGenerating(true);
      
      // Create project
      const projectResponse = await projectsAPI.create({
        title: projectData.title,
        description: projectData.description,
        requirements: projectData.requirements
      });
      
      const newProjectId = projectResponse.data.id;
      setProjectId(newProjectId);

      // Upload files if any
      if (projectData.files.length > 0) {
        for (const file of projectData.files) {
          await filesAPI.upload(file, newProjectId);
        }
      }

      // Generate MVP plan
      const mvpResponse = await mvpAPI.generate({
        projectId: newProjectId,
        requirements: projectData.requirements,
        projectTitle: projectData.title,
        provider: projectData.provider,
        planType: 'full_mvp'
      });

      // Handle different possible response structures
      const planContent = mvpResponse.data.content || 
                         mvpResponse.data.result?.content || 
                         mvpResponse.data.plan?.content ||
                         'MVP plan generated successfully';
      
      setGeneratedPlan(planContent);
      
      console.log('MVP Response:', mvpResponse.data); // Debug log
      console.log('Project ID set to:', newProjectId); // Debug log

      toast({
        title: "MVP Plan Generated!",
        description: "Your MVP plan has been generated successfully.",
      });

      nextStep(); // Move to document generation step
    } catch (error) {
      console.error('Generation error:', error);
      toast({
        title: "Generation Failed",
        description: "Failed to generate MVP plan. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const steps = [
    {
      number: 1,
      title: "Project Details",
      description: "Basic information about your project"
    },
    {
      number: 2,
      title: "Requirements & Files",
      description: "Upload files and define requirements"
    },
    {
      number: 3,
      title: "MVP Generation",
      description: "Generate your MVP plan with AI"
    },
    {
      number: 4,
      title: "Document Generation",
      description: "Generate comprehensive project documents"
    }
  ];

  const renderStepContent = () => {
    switch (currentStep) {
      case 1:
        return (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings className="w-5 h-5" />
                Project Details
              </CardTitle>
              <CardDescription>
                Tell us about your project. This information will be used to generate your MVP plan.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="title">Project Title *</Label>
                <Input
                  id="title"
                  placeholder="e.g., Task Management App"
                  value={projectData.title}
                  onChange={(e) => setProjectData(prev => ({ ...prev, title: e.target.value }))}
                />
              </div>
              <div>
                <Label htmlFor="description">Project Description</Label>
                <Input
                  id="description"
                  placeholder="Brief description of your project"
                  value={projectData.description}
                  onChange={(e) => setProjectData(prev => ({ ...prev, description: e.target.value }))}
                />
              </div>
            </CardContent>
          </Card>
        );

      case 2:
        return (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="w-5 h-5" />
                  Requirements & Files
                </CardTitle>
                <CardDescription>
                  Upload relevant files and describe your project requirements.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="requirements">Project Requirements</Label>
                  <textarea
                    id="requirements"
                    className="w-full min-h-[120px] p-3 border border-gray-300 rounded-md resize-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="Describe what you want to build, key features, target audience, etc."
                    value={projectData.requirements}
                    onChange={(e) => setProjectData(prev => ({ ...prev, requirements: e.target.value }))}
                  />
                </div>
                <FileUpload onFileSelect={handleFileSelect} />
                {projectData.files.length > 0 && (
                  <div className="text-sm text-gray-600">
                    {projectData.files.length} file(s) selected
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        );

      case 3:
        return (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Zap className="w-5 h-5" />
                MVP Generation
              </CardTitle>
              <CardDescription>
                Choose your AI provider and generate your MVP plan.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="provider">AI Provider</Label>
                <select
                  id="provider"
                  className="w-full p-2 border border-gray-300 rounded-md"
                  value={projectData.provider}
                  onChange={(e) => setProjectData(prev => ({ ...prev, provider: e.target.value }))}
                >
                  <option value="openai">OpenAI (GPT-4)</option>
                  <option value="anthropic">Anthropic (Claude)</option>
                  <option value="google">Google (Gemini)</option>
                  <option value="deepseek">DeepSeek</option>
                </select>
              </div>
              
              {generatedPlan ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-green-600">
                    <CheckCircle className="w-5 h-5" />
                    <span className="font-medium">MVP Plan Generated Successfully!</span>
                  </div>
                  <div className="p-4 bg-gray-50 rounded-lg max-h-60 overflow-y-auto">
                    <pre className="whitespace-pre-wrap text-sm">{generatedPlan}</pre>
                  </div>
                </div>
              ) : (
                <Button
                  onClick={handleProjectSubmit}
                  disabled={isGenerating || !projectData.title.trim()}
                  className="w-full flex items-center gap-2"
                >
                  {isGenerating ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Generating MVP Plan...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" />
                      Generate MVP Plan
                    </>
                  )}
                </Button>
              )}
            </CardContent>
          </Card>
        );

      case 4:
        return (
          <div className="space-y-6">
            {projectId ? (
              <DocumentGenerator
                projectId={projectId}
                projectTitle={projectData.title}
                requirements={projectData.requirements}
                provider={projectData.provider}
                onDocumentsGenerated={(documents) => {
                  toast({
                    title: "Documents Generated",
                    description: `Successfully generated ${documents.length} documents.`,
                  });
                }}
              />
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle>Document Generation</CardTitle>
                  <CardDescription>
                    Please complete the MVP generation step first.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-gray-600">
                    You need to generate an MVP plan before you can create project documents.
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        );

      default:
        return null;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Authentication Required</CardTitle>
            <CardDescription>Please log in to generate MVP plans.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-4xl mx-auto px-4">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Generate Your MVP</h1>
          <p className="text-gray-600">
            Create a comprehensive MVP plan and project documents with AI assistance
          </p>
        </div>

        {/* Progress Steps */}
        <div className="flex items-center justify-between mb-8">
          {steps.map((step, index) => (
            <div key={step.number} className="flex items-center">
              <div className={`flex items-center justify-center w-10 h-10 rounded-full border-2 ${
                currentStep >= step.number 
                  ? 'bg-blue-600 border-blue-600 text-white' 
                  : 'border-gray-300 text-gray-500'
              }`}>
                {currentStep > step.number ? (
                  <CheckCircle className="w-5 h-5" />
                ) : (
                  step.number
                )}
              </div>
              <div className="ml-3 hidden sm:block">
                <p className={`text-sm font-medium ${
                  currentStep >= step.number ? 'text-blue-600' : 'text-gray-500'
                }`}>
                  {step.title}
                </p>
                <p className="text-xs text-gray-500">{step.description}</p>
              </div>
              {index < steps.length - 1 && (
                <div className={`w-12 h-0.5 mx-4 ${
                  currentStep > step.number ? 'bg-blue-600' : 'bg-gray-300'
                }`} />
              )}
            </div>
          ))}
        </div>

        {/* Step Content */}
        <div className="mb-8">
          {renderStepContent()}
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            onClick={prevStep}
            disabled={currentStep === 1}
            className="flex items-center gap-2"
          >
            <ArrowLeft className="w-4 h-4" />
            Previous
          </Button>
          
          <div className="text-sm text-gray-500">
            Step {currentStep} of {steps.length}
          </div>

          <Button
            onClick={nextStep}
            disabled={
              currentStep === steps.length || 
              (currentStep === 3 && !generatedPlan) ||
              (currentStep === 1 && !projectData.title.trim())
            }
            className="flex items-center gap-2"
          >
            Next
            <ArrowRight className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
