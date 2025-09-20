import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { documentsAPI, estimationSettingsAPI } from '@/lib/api';
import { 
  FileText, 
  Loader2, 
  Download, 
  CheckCircle,
  AlertCircle,
  Sparkles,
  Clock,
  Calculator,
  Eye,
  X
} from 'lucide-react';

interface DocumentGeneratorProps {
  projectId: string;
  projectTitle: string;
  requirements: string;
  provider: string;
  onDocumentsGenerated?: (documents: any[]) => void;
}

type DocumentType = 'prd' | 'requirements' | 'techstack' | 'frontend' | 'backend' | 'flow' | 'status' | 'estimation';

interface DocumentTypeInfo {
  id: DocumentType;
  name: string;
  description: string;
  icon: React.ReactNode;
  complexity: 'simple' | 'complex';
}

interface EstimationSetting {
  id: string;
  name: string;
  description?: string;
  isDefault: boolean;
}

const documentTypes: DocumentTypeInfo[] = [
  {
    id: 'prd',
    name: 'Product Requirements Document',
    description: 'Detailed PRD with specifications and user experience',
    icon: <FileText className="w-4 h-4" />,
    complexity: 'simple'
  },
  {
    id: 'requirements',
    name: 'Requirements Document',
    description: 'Functional and non-functional requirements analysis',
    icon: <FileText className="w-4 h-4" />,
    complexity: 'simple'
  },
  {
    id: 'techstack',
    name: 'Technology Stack',
    description: 'Recommended technologies and architecture decisions',
    icon: <Sparkles className="w-4 h-4" />,
    complexity: 'complex'
  },
  {
    id: 'frontend',
    name: 'Frontend Implementation',
    description: 'Component structure and UI implementation guide',
    icon: <FileText className="w-4 h-4" />,
    complexity: 'complex'
  },
  {
    id: 'backend',
    name: 'Backend Implementation',
    description: 'API design, data models, and server architecture',
    icon: <FileText className="w-4 h-4" />,
    complexity: 'complex'
  },
  {
    id: 'flow',
    name: 'System Flow Documentation',
    description: 'User workflows and system integration diagrams',
    icon: <FileText className="w-4 h-4" />,
    complexity: 'simple'
  },
  {
    id: 'status',
    name: 'Project Status Template',
    description: 'Implementation phases and milestone tracking',
    icon: <CheckCircle className="w-4 h-4" />,
    complexity: 'simple'
  },
  {
    id: 'estimation',
    name: 'Project Estimation',
    description: 'Work breakdown structure with time and resource estimates',
    icon: <Clock className="w-4 h-4" />,
    complexity: 'complex'
  }
];

export default function DocumentGenerator({ 
  projectId, 
  projectTitle, 
  requirements, 
  provider, 
  onDocumentsGenerated 
}: DocumentGeneratorProps) {
  const [selectedDocuments, setSelectedDocuments] = useState<Set<DocumentType>>(new Set());
  const [generating, setGenerating] = useState(false);
  const [generatedDocuments, setGeneratedDocuments] = useState<any[]>([]);
  const [estimationSettings, setEstimationSettings] = useState<EstimationSetting[]>([]);
  const [selectedEstimationSettingId, setSelectedEstimationSettingId] = useState<string>('');
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [previewDocument, setPreviewDocument] = useState<any>(null);
  const { toast } = useToast();

  useEffect(() => {
    fetchEstimationSettings();
  }, []);

  const fetchEstimationSettings = async () => {
    try {
      setLoadingSettings(true);
      const response = await estimationSettingsAPI.list();
      setEstimationSettings(response.data.settings);
      
      // Auto-select default setting if available
      const defaultSetting = response.data.settings.find((s: EstimationSetting) => s.isDefault);
      if (defaultSetting) {
        setSelectedEstimationSettingId(defaultSetting.id);
      }
    } catch (error) {
      console.error('Error fetching estimation settings:', error);
    } finally {
      setLoadingSettings(false);
    }
  };

  const handleDocumentToggle = (documentType: DocumentType) => {
    setSelectedDocuments(prev => 
      prev.has(documentType)
        ? new Set([...prev].filter(type => type !== documentType))
        : new Set([...prev, documentType])
    );
  };

  const selectAllDocuments = () => {
    setSelectedDocuments(new Set(documentTypes.map(doc => doc.id)));
  };

  const clearSelection = () => {
    setSelectedDocuments(new Set());
  };

  const generateDocuments = async () => {
    if (selectedDocuments.size === 0) {
      toast({
        title: "No documents selected",
        description: "Please select at least one document type to generate.",
        variant: "destructive",
      });
      return;
    }

    // Check if estimation document is selected but no settings chosen
    if (selectedDocuments.has('estimation') && !selectedEstimationSettingId) {
      toast({
        title: "Estimation settings required",
        description: "Please select estimation settings for the estimation document.",
        variant: "destructive",
      });
      return;
    }

    try {
      setGenerating(true);
      const documentTypesArray = Array.from(selectedDocuments);
      
      const response = await documentsAPI.generateBatch({
        projectId,
        requirements,
        projectTitle,
        provider,
        documentTypes: documentTypesArray,
        estimationSettingsId: selectedDocuments.has('estimation') ? selectedEstimationSettingId : undefined
      });

      setGeneratedDocuments(response.documents);
      onDocumentsGenerated?.(response.documents);
      
      toast({
        title: "Documents generated successfully",
        description: `Generated ${documentTypesArray.length} document${documentTypesArray.length > 1 ? 's' : ''}.`,
      });
    } catch (error) {
      console.error('Error generating documents:', error);
      toast({
        title: "Generation failed",
        description: "Failed to generate documents. Please try again.",
        variant: "destructive",
      });
    } finally {
      setGenerating(false);
    }
  };

  const downloadDocument = (generatedDoc: any) => {
    const blob = new Blob([generatedDoc.content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${generatedDoc.documentType}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const previewDocumentHtml = (generatedDoc: any) => {
    setPreviewDocument(generatedDoc);
    setShowPreviewModal(true);
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5" />
            Document Generation
          </CardTitle>
          <CardDescription>
            Generate comprehensive project documents using AI. Select the documents you need for your MVP.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Document Selection */}
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium">Select Documents</h3>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={selectAllDocuments}>
                  Select All
                </Button>
                <Button variant="outline" size="sm" onClick={clearSelection}>
                  Clear
                </Button>
              </div>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {documentTypes.map((docType) => {
                const isSelected = selectedDocuments.has(docType.id);
                
                return (
                  <Card 
                    key={docType.id}
                    className={`cursor-pointer transition-all ${
                      isSelected ? 'ring-2 ring-blue-500 bg-blue-50' : 'hover:shadow-md'
                    }`}
                    onClick={() => handleDocumentToggle(docType.id)}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => handleDocumentToggle(docType.id)}
                          className="mt-1 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                        />
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            {docType.icon}
                            <h4 className="font-medium text-sm">{docType.name}</h4>
                            <span className={`px-2 py-1 text-xs rounded-full ${
                              docType.complexity === 'complex' 
                                ? 'bg-orange-100 text-orange-800' 
                                : 'bg-green-100 text-green-800'
                            }`}>
                              {docType.complexity}
                            </span>
                          </div>
                          <p className="text-xs text-gray-600 mb-2">{docType.description}</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>

          {/* Estimation Settings Selection */}
          {selectedDocuments.has('estimation') && (
            <Card className="mb-6">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Calculator className="w-5 h-5" />
                  Estimation Settings
                </CardTitle>
                <CardDescription>
                  Select the estimation settings to use for project estimation calculations
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="estimation-settings">Estimation Settings</Label>
                    <Select
                      value={selectedEstimationSettingId}
                      onValueChange={setSelectedEstimationSettingId}
                      disabled={loadingSettings}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={loadingSettings ? "Loading..." : "Select estimation settings"} />
                      </SelectTrigger>
                      <SelectContent>
                        {estimationSettings.map((setting) => (
                          <SelectItem key={setting.id} value={setting.id}>
                            <div className="flex items-center gap-2">
                              <span>{setting.name}</span>
                              {setting.isDefault && (
                                <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">
                                  Default
                                </span>
                              )}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {estimationSettings.length === 0 && !loadingSettings && (
                      <p className="text-sm text-gray-600 mt-2">
                        No estimation settings found. 
                        <a href="/estimation-settings" className="text-blue-600 hover:underline ml-1">
                          Create one first
                        </a>
                      </p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Generation Controls */}
          <div className="flex items-center justify-between pt-4 border-t">
            <div className="text-sm text-gray-600">
              {selectedDocuments.size} document{selectedDocuments.size !== 1 ? 's' : ''}
            </div>
            <Button 
              onClick={generateDocuments}
              disabled={selectedDocuments.size === 0 || generating}
              className="flex items-center gap-2"
            >
              {generating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  Generate Documents
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Generated Documents */}
      {generatedDocuments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Generated Documents</CardTitle>
            <CardDescription>
              Your generated documents are ready for download.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {generatedDocuments.map((doc, index) => (
                <div key={index} className="flex items-center justify-between p-3 border rounded-lg">
                  <div className="flex items-center gap-3">
                    <FileText className="w-4 h-4 text-gray-500" />
                    <div>
                      <h4 className="font-medium text-sm">
                        {documentTypes.find(d => d.id === doc.documentType)?.name}
                      </h4>
                      <p className="text-xs text-gray-500">
                        Generated with {doc.model} • {new Date(doc.createdAt).toLocaleString()}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => downloadDocument(doc)}
                      className="flex items-center gap-1"
                    >
                      <Download className="w-3 h-3" />
                      Download
                    </Button>
                    {doc.documentType === 'estimation' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => previewDocumentHtml(doc)}
                        className="flex items-center gap-1"
                      >
                        <Eye className="w-3 h-3" />
                        Preview
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Preview Modal */}
      {showPreviewModal && previewDocument && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg w-full max-w-6xl h-full max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="font-medium text-lg">
                {documentTypes.find(d => d.id === previewDocument.documentType)?.name} - Preview
              </h3>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => downloadDocument(previewDocument)}
                  className="flex items-center gap-1"
                >
                  <Download className="w-3 h-3" />
                  Download
                </Button>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => setShowPreviewModal(false)}
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-0">
              <div 
                className="w-full h-full"
                dangerouslySetInnerHTML={{ __html: previewDocument?.content || '' }} 
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
