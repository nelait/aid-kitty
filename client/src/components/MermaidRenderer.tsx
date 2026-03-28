import React, { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';

// Initialize mermaid with theme settings
mermaid.initialize({
    startOnLoad: false,
    theme: 'default',
    securityLevel: 'loose',
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
});

interface MermaidRendererProps {
    content: string;
    className?: string;
}

/**
 * Extracts mermaid code blocks from markdown content and renders them.
 * Also renders any text outside of mermaid blocks as prose.
 */
export default function MermaidRenderer({ content, className = '' }: MermaidRendererProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [renderedContent, setRenderedContent] = useState<JSX.Element[]>([]);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const renderMermaid = async () => {
            if (!content) return;

            try {
                // Parse content to find mermaid code blocks
                const mermaidBlockRegex = /```mermaid\n([\s\S]*?)```/g;
                const parts: JSX.Element[] = [];
                let lastIndex = 0;
                let match;
                let diagramIndex = 0;

                while ((match = mermaidBlockRegex.exec(content)) !== null) {
                    // Add text before this mermaid block
                    if (match.index > lastIndex) {
                        const textBefore = content.slice(lastIndex, match.index);
                        if (textBefore.trim()) {
                            parts.push(
                                <div key={`text-${lastIndex}`} className="prose prose-sm max-w-none mb-4">
                                    <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed bg-transparent border-none p-0">
                                        {textBefore}
                                    </pre>
                                </div>
                            );
                        }
                    }

                    // Render the mermaid diagram
                    const diagramCode = match[1].trim();
                    const diagramId = `mermaid-diagram-${diagramIndex++}`;

                    try {
                        const { svg } = await mermaid.render(diagramId, diagramCode);
                        parts.push(
                            <div
                                key={diagramId}
                                className="mermaid-diagram my-6 p-4 bg-white rounded-lg border border-gray-200 shadow-sm overflow-auto"
                                dangerouslySetInnerHTML={{ __html: svg }}
                            />
                        );
                    } catch (renderError) {
                        console.error('Mermaid render error:', renderError);
                        // Show the raw code if rendering fails
                        parts.push(
                            <div key={diagramId} className="my-6 p-4 bg-red-50 rounded-lg border border-red-200">
                                <p className="text-red-600 text-sm mb-2">Failed to render diagram:</p>
                                <pre className="text-xs bg-red-100 p-2 rounded overflow-auto">
                                    {diagramCode}
                                </pre>
                            </div>
                        );
                    }

                    lastIndex = match.index + match[0].length;
                }

                // Add any remaining text after the last mermaid block
                if (lastIndex < content.length) {
                    const textAfter = content.slice(lastIndex);
                    if (textAfter.trim()) {
                        parts.push(
                            <div key={`text-${lastIndex}`} className="prose prose-sm max-w-none">
                                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed bg-transparent border-none p-0">
                                    {textAfter}
                                </pre>
                            </div>
                        );
                    }
                }

                // If no mermaid blocks found, just show the content as plain text
                if (parts.length === 0) {
                    parts.push(
                        <div key="fallback" className="prose prose-sm max-w-none">
                            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">
                                {content}
                            </pre>
                        </div>
                    );
                }

                setRenderedContent(parts);
                setError(null);
            } catch (err) {
                console.error('Error rendering mermaid content:', err);
                setError('Failed to process diagram content');
            }
        };

        renderMermaid();
    }, [content]);

    if (error) {
        return (
            <div className={`text-red-600 p-4 ${className}`}>
                <p>{error}</p>
                <pre className="mt-2 text-xs bg-gray-100 p-2 rounded overflow-auto">
                    {content}
                </pre>
            </div>
        );
    }

    return (
        <div ref={containerRef} className={className}>
            {renderedContent}
        </div>
    );
}
