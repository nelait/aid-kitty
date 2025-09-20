import React, { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { documentsAPI } from '@/lib/api';
import { 
  FileText, 
  Download, 
  ArrowLeft,
  Calendar,
  User,
  Loader2,
  AlertCircle,
  Eye,
  X
} from 'lucide-react';

interface GeneratedDocument {
  id: string;
  projectId: string;
  model: string;
  documentType: string;
  content: string;
  tokensUsed: number;
  generationTime: number;
  createdAt: string;
}

const documentTypeNames: Record<string, string> = {
  prd: 'Product Requirements Document',
  requirements: 'Technical Requirements',
  techstack: 'Technology Stack',
  frontend: 'Frontend Implementation',
  backend: 'Backend Implementation',
  flow: 'User Flow & Architecture',
  status: 'Project Status',
  estimation: 'Project Estimation'
};

const documentTypeDescriptions: Record<string, string> = {
  prd: 'Comprehensive product requirements and specifications',
  requirements: 'Detailed technical requirements and constraints',
  techstack: 'Recommended technologies and tools',
  frontend: 'Frontend architecture and implementation guide',
  backend: 'Backend architecture and API specifications',
  flow: 'User journey and system architecture flows',
  status: 'Current project status and next steps',
  estimation: 'Work breakdown structure with time and resource estimates'
};

export default function ProjectDocumentsPage() {
  const [location, setLocation] = useLocation();
  
  // Extract projectId from URL path like /projects/123/documents
  const projectId = location.split('/')[2];
  
  console.log('ProjectDocumentsPage Debug:', {
    location,
    projectId,
    locationParts: location.split('/')
  });
  
  const [documents, setDocuments] = useState<GeneratedDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDocument, setSelectedDocument] = useState<GeneratedDocument | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [previewDocument, setPreviewDocument] = useState<GeneratedDocument | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    console.log('useEffect triggered:', { projectId });
    if (projectId) {
      fetchDocuments();
    }
  }, [projectId]);

  const fetchDocuments = async () => {
    try {
      console.log('Fetching documents for projectId:', projectId);
      setLoading(true);
      const response = await documentsAPI.getProjectDocuments(projectId!);
      console.log('Documents API response:', response);
      setDocuments(response.documents || []);
    } catch (error) {
      console.error('Error fetching documents:', error);
      setError('Failed to load documents');
      toast({
        title: "Error",
        description: "Failed to load documents. Please try again.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const downloadDocument = (doc: GeneratedDocument) => {
    const blob = new Blob([doc.content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${doc.documentType}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toast({
      title: "Download Started",
      description: `${documentTypeNames[doc.documentType]} downloaded successfully.`,
    });
  };

  const viewDocument = (doc: GeneratedDocument) => {
    setSelectedDocument(doc);
    setViewerOpen(true);
  };

  const closeViewer = () => {
    setViewerOpen(false);
    setSelectedDocument(null);
  };

  const previewDocumentHtml = (doc: GeneratedDocument) => {
    setPreviewDocument(doc);
    setShowPreviewModal(true);
  };

  const closePreviewModal = () => {
    setShowPreviewModal(false);
    setPreviewDocument(null);
  };

  if (loading) {
    console.log('Rendering loading state');
    return (
      <div className="min-h-screen bg-gray-50 py-8">
        <div className="max-w-6xl mx-auto px-4">
          <div className="flex items-center justify-center min-h-[400px]">
            <div className="text-center">
              <Loader2 className="w-8 h-8 animate-spin mx-auto mb-4" />
              <p className="text-gray-600">Loading documents...</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    console.log('Rendering error state');
    return (
      <div className="min-h-screen bg-gray-50 py-8">
        <div className="max-w-6xl mx-auto px-4">
          <div className="flex items-center justify-center min-h-[400px]">
            <div className="text-center">
              <AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-4" />
              <p className="text-gray-600">{error}</p>
              <Button onClick={fetchDocuments} className="mt-4">
                Try Again
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  console.log('Rendering main content');
  return (
    <>
      <div className="min-h-screen bg-gray-50 py-8">
        <div className="max-w-6xl mx-auto px-4">
          {/* Header */}
          <div className="flex items-center gap-4 mb-8">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLocation('/projects')}
              className="flex items-center gap-2"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Projects
            </Button>
            <div>
              <h1 className="text-3xl font-bold text-gray-900">Project Documents</h1>
              <p className="text-gray-600 mt-2">
                View and download generated project documents
              </p>
            </div>
          </div>

          {/* Documents Grid */}
          {documents && documents.length === 0 ? (
            <Card className="text-center py-12">
              <CardContent>
                <FileText className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-gray-900 mb-2">No documents generated</h3>
                <p className="text-gray-600 mb-6">
                  Generate documents for this project to view them here.
                </p>
                <Button onClick={() => setLocation(`/generate?projectId=${projectId}`)}>
                  Generate Documents
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {documents && documents.map((doc) => (
                <Card key={doc.id} className="hover:shadow-md transition-shadow">
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <CardTitle className="text-lg font-medium">
                          {documentTypeNames[doc.documentType] || doc.documentType}
                        </CardTitle>
                        <CardDescription className="mt-2">
                          {documentTypeDescriptions[doc.documentType] || 'Generated document'}
                        </CardDescription>
                      </div>
                      <div className="bg-blue-100 text-blue-800 px-2 py-1 text-xs rounded-full">
                        {doc.documentType.toUpperCase()}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-4">
                      {/* Document Info */}
                      <div className="space-y-2 text-sm text-gray-600">
                        <div className="flex items-center gap-2">
                          <User className="w-4 h-4" />
                          Generated with {doc.model}
                        </div>
                        <div className="flex items-center gap-2">
                          <Calendar className="w-4 h-4" />
                          {new Date(doc.createdAt).toLocaleDateString()} at {new Date(doc.createdAt).toLocaleTimeString()}
                        </div>
                        {doc.generationTime > 0 && (
                          <div className="text-xs text-gray-500">
                            Generated in {(doc.generationTime / 1000).toFixed(1)}s
                          </div>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => viewDocument(doc)}
                          className="flex-1 flex items-center gap-2"
                        >
                          <Eye className="w-4 h-4" />
                          View
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => downloadDocument(doc)}
                          className="flex items-center gap-2"
                        >
                          <Download className="w-4 h-4" />
                          Download
                        </Button>
                        {doc.documentType === 'estimation' && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => previewDocumentHtml(doc)}
                            className="flex items-center gap-2"
                          >
                            Preview
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Document Viewer Modal */}
      {viewerOpen && selectedDocument && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] flex flex-col">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-6 border-b">
              <div>
                <h2 className="text-xl font-semibold">
                  {documentTypeNames[selectedDocument.documentType]}
                </h2>
                <p className="text-sm text-gray-600 mt-1">
                  Generated with {selectedDocument.model} • {new Date(selectedDocument.createdAt).toLocaleDateString()}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => downloadDocument(selectedDocument)}
                  className="flex items-center gap-2"
                >
                  <Download className="w-4 h-4" />
                  Download
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={closeViewer}
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </div>

            {/* Modal Content */}
            <div className="flex-1 overflow-auto p-6">
              <div className="prose prose-sm max-w-none">
                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">
                  {selectedDocument.content}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Preview Modal */}
      {showPreviewModal && previewDocument && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] flex flex-col">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-6 border-b">
              <div>
                <h2 className="text-xl font-semibold">
                  {documentTypeNames[previewDocument.documentType]}
                </h2>
                <p className="text-sm text-gray-600 mt-1">
                  Generated with {previewDocument.model} • {new Date(previewDocument.createdAt).toLocaleDateString()}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => downloadDocument(previewDocument)}
                  className="flex items-center gap-2"
                >
                  <Download className="w-4 h-4" />
                  Download
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={closePreviewModal}
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </div>

            {/* Modal Content */}
            <div className="flex-1 overflow-auto p-6">
              <div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: previewDocument.content }} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
