import React, { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { estimationSettingsAPI } from '@/lib/api';
import { 
  Settings, 
  Plus, 
  Edit, 
  Trash2, 
  Save, 
  X,
  Calculator,
  Loader2,
  AlertCircle,
  Star
} from 'lucide-react';

interface EstimationSetting {
  id: string;
  name: string;
  description?: string;
  complexityWeights: {
    simple: number;
    average: number;
    complex: number;
  };
  functionTypes: {
    externalInputs: { simple: number; average: number; complex: number };
    externalOutputs: { simple: number; average: number; complex: number };
    externalInquiries: { simple: number; average: number; complex: number };
    internalLogicalFiles: { simple: number; average: number; complex: number };
    externalInterfaceFiles: { simple: number; average: number; complex: number };
  };
  environmentalFactors: {
    dataCommunications: number;
    distributedDataProcessing: number;
    performance: number;
    heavilyUsedConfiguration: number;
    transactionRate: number;
    onlineDataEntry: number;
    endUserEfficiency: number;
    onlineUpdate: number;
    complexProcessing: number;
    reusability: number;
    installationEase: number;
    operationalEase: number;
    multipleSites: number;
    facilitateChange: number;
  };
  projectParameters: {
    teamProductivity: number;
    bufferPercentage: number;
    hourlyRate: number;
    hoursPerDay: number;
    workingDaysPerMonth: number;
  };
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

const defaultFormData = {
  name: '',
  description: '',
  complexityWeights: { simple: 3, average: 4, complex: 6 },
  functionTypes: {
    externalInputs: { simple: 3, average: 4, complex: 6 },
    externalOutputs: { simple: 4, average: 5, complex: 7 },
    externalInquiries: { simple: 3, average: 4, complex: 6 },
    internalLogicalFiles: { simple: 7, average: 10, complex: 15 },
    externalInterfaceFiles: { simple: 5, average: 7, complex: 10 }
  },
  environmentalFactors: {
    dataCommunications: 3,
    distributedDataProcessing: 2,
    performance: 4,
    heavilyUsedConfiguration: 3,
    transactionRate: 3,
    onlineDataEntry: 4,
    endUserEfficiency: 4,
    onlineUpdate: 3,
    complexProcessing: 3,
    reusability: 3,
    installationEase: 3,
    operationalEase: 3,
    multipleSites: 2,
    facilitateChange: 4
  },
  projectParameters: {
    teamProductivity: 5,
    bufferPercentage: 20,
    hourlyRate: 75,
    hoursPerDay: 8,
    workingDaysPerMonth: 22
  },
  isDefault: false
};

export default function EstimationSettingsPage() {
  const [location, setLocation] = useLocation();
  const [settings, setSettings] = useState<EstimationSetting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState(defaultFormData);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      setLoading(true);
      const response = await estimationSettingsAPI.list();
      setSettings(response.data.settings);
    } catch (error) {
      console.error('Error fetching estimation settings:', error);
      setError('Failed to load estimation settings');
      toast({
        title: "Error",
        description: "Failed to load estimation settings. Please try again.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = () => {
    setFormData(defaultFormData);
    setEditingId(null);
    setShowForm(true);
  };

  const handleEdit = (setting: EstimationSetting) => {
    setFormData({
      name: setting.name,
      description: setting.description || '',
      complexityWeights: setting.complexityWeights,
      functionTypes: setting.functionTypes,
      environmentalFactors: setting.environmentalFactors,
      projectParameters: setting.projectParameters,
      isDefault: setting.isDefault
    });
    setEditingId(setting.id);
    setShowForm(true);
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      
      if (editingId) {
        await estimationSettingsAPI.update(editingId, formData);
        toast({
          title: "Success",
          description: "Estimation setting updated successfully.",
        });
      } else {
        await estimationSettingsAPI.create(formData);
        toast({
          title: "Success",
          description: "Estimation setting created successfully.",
        });
      }
      
      setShowForm(false);
      setEditingId(null);
      fetchSettings();
    } catch (error) {
      console.error('Error saving estimation setting:', error);
      toast({
        title: "Error",
        description: "Failed to save estimation setting. Please try again.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this estimation setting?')) {
      return;
    }
    
    try {
      await estimationSettingsAPI.delete(id);
      toast({
        title: "Success",
        description: "Estimation setting deleted successfully.",
      });
      fetchSettings();
    } catch (error) {
      console.error('Error deleting estimation setting:', error);
      toast({
        title: "Error",
        description: "Failed to delete estimation setting. Please try again.",
        variant: "destructive",
      });
    }
  };

  const updateFormField = (path: string, value: any) => {
    setFormData(prev => {
      const keys = path.split('.');
      const newData = { ...prev };
      let current: any = newData;
      
      for (let i = 0; i < keys.length - 1; i++) {
        current[keys[i]] = { ...current[keys[i]] };
        current = current[keys[i]];
      }
      
      current[keys[keys.length - 1]] = value;
      return newData;
    });
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 py-8">
        <div className="max-w-6xl mx-auto px-4">
          <div className="flex items-center justify-center min-h-[400px]">
            <div className="text-center">
              <Loader2 className="w-8 h-8 animate-spin mx-auto mb-4" />
              <p className="text-gray-600">Loading estimation settings...</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 py-8">
        <div className="max-w-6xl mx-auto px-4">
          <div className="flex items-center justify-center min-h-[400px]">
            <div className="text-center">
              <AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-4" />
              <p className="text-gray-600">{error}</p>
              <Button onClick={fetchSettings} className="mt-4">
                Try Again
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-6xl mx-auto px-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Estimation Settings</h1>
            <p className="text-gray-600 mt-2">
              Configure Function Point Analysis parameters for project estimation
            </p>
          </div>
          <Button onClick={handleCreate} className="flex items-center gap-2">
            <Plus className="w-4 h-4" />
            New Setting
          </Button>
        </div>

        {/* Settings List */}
        {!showForm && (
          <>
            {settings.length === 0 ? (
              <Card className="text-center py-12">
                <CardContent>
                  <Calculator className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                  <h3 className="text-lg font-medium text-gray-900 mb-2">No estimation settings</h3>
                  <p className="text-gray-600 mb-6">
                    Create your first estimation setting to configure Function Point Analysis parameters.
                  </p>
                  <Button onClick={handleCreate}>
                    <Plus className="w-4 h-4 mr-2" />
                    Create First Setting
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {settings.map((setting) => (
                  <Card key={setting.id} className="hover:shadow-md transition-shadow">
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <CardTitle className="text-lg font-medium flex items-center gap-2">
                            {setting.name}
                            {setting.isDefault && <Star className="w-4 h-4 text-yellow-500 fill-current" />}
                          </CardTitle>
                          {setting.description && (
                            <CardDescription className="mt-2">
                              {setting.description}
                            </CardDescription>
                          )}
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-4">
                        {/* Key Parameters */}
                        <div className="text-sm text-gray-600 space-y-1">
                          <div>Team Productivity: {setting.projectParameters.teamProductivity} FP/day</div>
                          <div>Buffer: {setting.projectParameters.bufferPercentage}%</div>
                          <div>Rate: ${setting.projectParameters.hourlyRate}/hour</div>
                        </div>

                        {/* Actions */}
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleEdit(setting)}
                            className="flex-1 flex items-center gap-2"
                          >
                            <Edit className="w-4 h-4" />
                            Edit
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleDelete(setting.id)}
                            className="flex items-center gap-2 text-red-600 hover:text-red-700"
                          >
                            <Trash2 className="w-4 h-4" />
                            Delete
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}

        {/* Form */}
        {showForm && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>
                    {editingId ? 'Edit Estimation Setting' : 'Create New Estimation Setting'}
                  </CardTitle>
                  <CardDescription>
                    Configure Function Point Analysis parameters for project estimation
                  </CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowForm(false)}
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-8">
              {/* Basic Info */}
              <div className="space-y-4">
                <h3 className="text-lg font-medium">Basic Information</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="name">Name *</Label>
                    <Input
                      id="name"
                      value={formData.name}
                      onChange={(e) => updateFormField('name', e.target.value)}
                      placeholder="e.g., Standard FPA Settings"
                    />
                  </div>
                  <div>
                    <Label htmlFor="isDefault">
                      <input
                        type="checkbox"
                        id="isDefault"
                        checked={formData.isDefault}
                        onChange={(e) => updateFormField('isDefault', e.target.checked)}
                        className="mr-2"
                      />
                      Set as default
                    </Label>
                  </div>
                </div>
                <div>
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    value={formData.description}
                    onChange={(e) => updateFormField('description', e.target.value)}
                    placeholder="Optional description of this estimation setting"
                  />
                </div>
              </div>

              {/* Function Types */}
              <div className="space-y-4">
                <h3 className="text-lg font-medium">Function Point Weights</h3>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {Object.entries(formData.functionTypes).map(([key, values]) => (
                    <div key={key} className="space-y-2">
                      <Label className="text-sm font-medium">
                        {key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())}
                      </Label>
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <Label className="text-xs text-gray-500">Simple</Label>
                          <Input
                            type="number"
                            value={values.simple}
                            onChange={(e) => updateFormField(`functionTypes.${key}.simple`, Number(e.target.value))}
                            className="text-sm"
                          />
                        </div>
                        <div>
                          <Label className="text-xs text-gray-500">Average</Label>
                          <Input
                            type="number"
                            value={values.average}
                            onChange={(e) => updateFormField(`functionTypes.${key}.average`, Number(e.target.value))}
                            className="text-sm"
                          />
                        </div>
                        <div>
                          <Label className="text-xs text-gray-500">Complex</Label>
                          <Input
                            type="number"
                            value={values.complex}
                            onChange={(e) => updateFormField(`functionTypes.${key}.complex`, Number(e.target.value))}
                            className="text-sm"
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Environmental Factors */}
              <div className="space-y-4">
                <h3 className="text-lg font-medium">Environmental Factors (0-5 scale)</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {Object.entries(formData.environmentalFactors).map(([key, value]) => (
                    <div key={key}>
                      <Label className="text-sm">
                        {key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())}
                      </Label>
                      <Input
                        type="number"
                        min="0"
                        max="5"
                        value={value}
                        onChange={(e) => updateFormField(`environmentalFactors.${key}`, Number(e.target.value))}
                        className="text-sm"
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Project Parameters */}
              <div className="space-y-4">
                <h3 className="text-lg font-medium">Project Parameters</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  <div>
                    <Label>Team Productivity (FP/day)</Label>
                    <Input
                      type="number"
                      value={formData.projectParameters.teamProductivity}
                      onChange={(e) => updateFormField('projectParameters.teamProductivity', Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <Label>Buffer Percentage (%)</Label>
                    <Input
                      type="number"
                      value={formData.projectParameters.bufferPercentage}
                      onChange={(e) => updateFormField('projectParameters.bufferPercentage', Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <Label>Hourly Rate ($)</Label>
                    <Input
                      type="number"
                      value={formData.projectParameters.hourlyRate}
                      onChange={(e) => updateFormField('projectParameters.hourlyRate', Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <Label>Hours per Day</Label>
                    <Input
                      type="number"
                      value={formData.projectParameters.hoursPerDay}
                      onChange={(e) => updateFormField('projectParameters.hoursPerDay', Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <Label>Working Days per Month</Label>
                    <Input
                      type="number"
                      value={formData.projectParameters.workingDaysPerMonth}
                      onChange={(e) => updateFormField('projectParameters.workingDaysPerMonth', Number(e.target.value))}
                    />
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-4 pt-4">
                <Button onClick={handleSave} disabled={saving || !formData.name.trim()}>
                  {saving ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  ) : (
                    <Save className="w-4 h-4 mr-2" />
                  )}
                  {editingId ? 'Update Setting' : 'Create Setting'}
                </Button>
                <Button variant="outline" onClick={() => setShowForm(false)}>
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
