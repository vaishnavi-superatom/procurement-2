import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { useEffect, useMemo } from 'react';
import { marked } from 'marked';
import type { ComponentMetadata } from '../types';

type Size = 'sm' | 'md' | 'lg';

interface MarkdownPreviewProps {
  content: string;
  size?: Size;
  className?: string;
}

const METADATA: ComponentMetadata = {
  id: 'generic-markdown-preview',
  name: 'MarkdownPreview',
  displayName: 'Markdown preview with DaisyUI styling',
  isDisplayComp: true,
  type: 'MarkdownPreview',
  description: 'Renders markdown/HTML content as styled JSX using Tiptap and DaisyUI classes.',
  category: 'display',
  keywords: ['markdown', 'preview', 'text', 'content', 'prose', 'html', 'table'],
  props: {
    content: 'Markdown or HTML string to render',
    size: '"sm" | "md" (default) | "lg"',
    className: 'Additional CSS classes',
  },
};

interface MarkdownPreviewComponent extends React.FC<MarkdownPreviewProps> {
  Metadata: ComponentMetadata;
}

const DEFAULT_CONTENT = `# Hello World

This is a **markdown preview** component with *beautiful* styling.

## Features

- Supports **bold** and *italic* text
- Lists and numbered items
- Code blocks and inline \`code\`

### Code Example

\`\`\`javascript
const greeting = "Hello!";
console.log(greeting);
\`\`\`

> This is a blockquote for important notes.

Visit [DaisyUI](https://daisyui.com) for more components.`;

const MarkdownPreview: MarkdownPreviewComponent = ({
  content = DEFAULT_CONTENT,
  size = 'md',
  className = '',
}) => {
  // Convert markdown to HTML using marked
  const htmlContent = useMemo(() => {
    // Check if content looks like markdown or is already HTML
    const isHtml = content.trim().startsWith('<');
    if (isHtml) return content;

    // Configure marked for GFM (GitHub Flavored Markdown)
    marked.setOptions({
      gfm: true,
      breaks: true,
    });

    return marked.parse(content) as string;
  }, [content]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3, 4, 5, 6],
        },
      }),
      Link.configure({
        openOnClick: true,
        HTMLAttributes: {
          class: 'link link-primary',
        },
      }),
      Image.configure({
        HTMLAttributes: {
          class: 'rounded-lg max-w-full',
        },
      }),
      Table.configure({
        resizable: false,
      }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: htmlContent,
    editable: false,
    editorProps: {
      attributes: {
        class: 'outline-none',
      },
    },
  });

  // Update content when prop changes
  useEffect(() => {
    if (editor && content) {
      editor.commands.setContent(htmlContent);
    }
  }, [content, editor, htmlContent]);

  const sizeClasses: Record<Size, string> = {
    sm: 'text-sm',
    md: 'text-base',
    lg: 'text-lg',
  };

  return (
    <div
      className={`
        markdown-preview
        ${sizeClasses[size]}
        ${className}

        [&_h1]:text-4xl [&_h1]:font-bold [&_h1]:mb-4 [&_h1]:mt-6 [&_h1]:text-base-content
        [&_h2]:text-3xl [&_h2]:font-bold [&_h2]:mb-3 [&_h2]:mt-5 [&_h2]:text-base-content
        [&_h3]:text-2xl [&_h3]:font-semibold [&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-base-content
        [&_h4]:text-xl [&_h4]:font-semibold [&_h4]:mb-2 [&_h4]:mt-3 [&_h4]:text-base-content
        [&_h5]:text-lg [&_h5]:font-medium [&_h5]:mb-1 [&_h5]:mt-2 [&_h5]:text-base-content
        [&_h6]:text-base [&_h6]:font-medium [&_h6]:mb-1 [&_h6]:mt-2 [&_h6]:text-base-content

        [&_p]:mb-4 [&_p]:leading-relaxed [&_p]:text-base-content/90

        [&_strong]:font-bold [&_strong]:text-base-content
        [&_em]:italic
        [&_del]:line-through [&_del]:text-base-content/60

        [&_a]:link [&_a]:link-primary [&_a]:hover:link-hover

        [&_ul]:list-disc [&_ul]:ml-6 [&_ul]:mb-4
        [&_ol]:list-decimal [&_ol]:ml-6 [&_ol]:mb-4
        [&_li]:mb-1 [&_li]:text-base-content/90

        [&_blockquote]:border-l-4 [&_blockquote]:border-primary [&_blockquote]:pl-4 [&_blockquote]:py-2 [&_blockquote]:my-4 [&_blockquote]:bg-base-200 [&_blockquote]:rounded-r-lg [&_blockquote]:italic [&_blockquote]:text-base-content/80

        [&_code]:bg-base-200 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-sm [&_code]:font-mono [&_code]:text-secondary
        [&_pre]:bg-base-300 [&_pre]:p-4 [&_pre]:rounded-lg [&_pre]:overflow-x-auto [&_pre]:mb-4
        [&_pre_code]:bg-transparent [&_pre_code]:p-0

        [&_hr]:border-base-300 [&_hr]:my-6

        [&_img]:rounded-lg [&_img]:max-w-full [&_img]:my-4

        [&_table]:table [&_table]:w-full [&_table]:mb-4 [&_table]:border-collapse
        [&_thead]:bg-base-200
        [&_th]:px-4 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold [&_th]:border [&_th]:border-base-300
        [&_td]:px-4 [&_td]:py-2 [&_td]:border [&_td]:border-base-300
        [&_tr:nth-child(even)]:bg-base-200/50
      `.trim().replace(/\s+/g, ' ')}
    >
      <EditorContent editor={editor} />
    </div>
  );
};

MarkdownPreview.Metadata = METADATA;

export default MarkdownPreview;
