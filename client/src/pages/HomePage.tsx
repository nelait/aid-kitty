import React from 'react';
import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { 
  Bot, 
  Zap, 
  FileText, 
  Sparkles, 
  ArrowRight,
  CheckCircle,
  Upload,
  Brain,
  Rocket
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';

export default function HomePage() {
  const { user } = useAuth();

  const features = [
    {
      icon: Brain,
      title: 'Multi-LLM AI Integration',
      description: 'Leverage OpenAI, Anthropic, Google, and DeepSeek models for comprehensive MVP planning.',
    },
    {
      icon: Upload,
      title: 'Document Processing',
      description: 'Upload PDFs and text files to extract requirements automatically.',
    },
    {
      icon: Rocket,
      title: 'Instant MVP Generation',
      description: 'Generate detailed MVP plans with technical specifications in minutes.',
    },
    {
      icon: FileText,
      title: 'Comprehensive Documentation',
      description: 'Get complete project documentation, architecture, and implementation guides.',
    },
  ];

  const steps = [
    {
      number: '01',
      title: 'Upload Requirements',
      description: 'Upload your project requirements as PDF or text files, or type them directly.',
    },
    {
      number: '02',
      title: 'Choose AI Model',
      description: 'Select from OpenAI, Anthropic, Google, or DeepSeek based on your needs.',
    },
    {
      number: '03',
      title: 'Generate MVP Plan',
      description: 'Get a detailed MVP plan with architecture, features, and implementation roadmap.',
    },
  ];

  return (
    <div className="min-h-screen">
      {/* Hero Section */}
      <section className="relative overflow-hidden bg-gradient-to-br from-blue-50 via-white to-purple-50">
        <div className="absolute inset-0 bg-grid-pattern opacity-5"></div>
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-24">
          <div className="text-center">
            <div className="flex justify-center mb-8">
              <div className="w-20 h-20 bg-gradient-to-br from-blue-500 to-purple-600 rounded-2xl flex items-center justify-center animate-float">
                <Bot className="w-10 h-10 text-white" />
              </div>
            </div>
            
            <h1 className="text-5xl md:text-6xl font-bold text-gray-900 mb-6">
              AI-Powered{' '}
              <span className="gradient-text">MVP Generator</span>
            </h1>
            
            <p className="text-xl text-gray-600 mb-8 max-w-3xl mx-auto">
              Transform your ideas into detailed MVP plans using cutting-edge AI. 
              Upload requirements, choose your AI model, and get comprehensive project blueprints in minutes.
            </p>
            
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              {user ? (
                <Link href="/generate">
                  <Button size="lg" className="text-lg px-8 py-3">
                    <Sparkles className="w-5 h-5 mr-2" />
                    Generate MVP Plan
                  </Button>
                </Link>
              ) : (
                <Link href="/register">
                  <Button size="lg" className="text-lg px-8 py-3">
                    Get Started Free
                    <ArrowRight className="w-5 h-5 ml-2" />
                  </Button>
                </Link>
              )}
              
              <Link href="/projects">
                <Button variant="outline" size="lg" className="text-lg px-8 py-3">
                  View Examples
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-24 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-gray-900 mb-4">
              Powerful Features for MVP Success
            </h2>
            <p className="text-xl text-gray-600 max-w-2xl mx-auto">
              Everything you need to transform ideas into actionable MVP plans
            </p>
          </div>
          
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
            {features.map((feature, index) => {
              const Icon = feature.icon;
              return (
                <Card key={index} className="border-0 shadow-lg hover:shadow-xl transition-shadow">
                  <CardHeader className="text-center pb-4">
                    <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center mx-auto mb-4">
                      <Icon className="w-6 h-6 text-white" />
                    </div>
                    <CardTitle className="text-lg">{feature.title}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-center">
                    <CardDescription className="text-gray-600">
                      {feature.description}
                    </CardDescription>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      </section>

      {/* How It Works Section */}
      <section className="py-24 bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-gray-900 mb-4">
              How It Works
            </h2>
            <p className="text-xl text-gray-600 max-w-2xl mx-auto">
              Three simple steps to generate your MVP plan
            </p>
          </div>
          
          <div className="grid md:grid-cols-3 gap-8">
            {steps.map((step, index) => (
              <div key={index} className="text-center">
                <div className="w-16 h-16 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center mx-auto mb-6">
                  <span className="text-2xl font-bold text-white">{step.number}</span>
                </div>
                <h3 className="text-xl font-semibold text-gray-900 mb-4">
                  {step.title}
                </h3>
                <p className="text-gray-600">
                  {step.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-24 bg-gradient-to-br from-blue-600 to-purple-700">
        <div className="max-w-4xl mx-auto text-center px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-6">
            Ready to Build Your MVP?
          </h2>
          <p className="text-xl text-blue-100 mb-8">
            Join thousands of entrepreneurs who've accelerated their product development with AI
          </p>
          
          {user ? (
            <Link href="/generate">
              <Button size="lg" variant="secondary" className="text-lg px-8 py-3">
                <Zap className="w-5 h-5 mr-2" />
                Start Generating
              </Button>
            </Link>
          ) : (
            <Link href="/register">
              <Button size="lg" variant="secondary" className="text-lg px-8 py-3">
                Get Started Now
                <ArrowRight className="w-5 h-5 ml-2" />
              </Button>
            </Link>
          )}
        </div>
      </section>
    </div>
  );
}
