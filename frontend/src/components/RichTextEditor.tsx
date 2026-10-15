import { useState, useRef, useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../types';

interface RichTextEditorProps {
  content?: string;
  placeholder?: string;
  onChange?: (html: string) => void;
  className?: string;
}

const METADATA: ComponentMetadata = {
  id: 'generic-rich-text-editor',
  name: 'RichTextEditor',
  displayName: 'Rich text editor with toolbar',
  isDisplayComp: true,
  type: 'RichTextEditor',
  description: 'WYSIWYG rich text editor with formatting toolbar using Tiptap and DaisyUI.',
  category: 'input',
  keywords: ['editor', 'rich text', 'wysiwyg', 'tiptap', 'formatting'],
  props: {
    content: 'Initial HTML content',
    placeholder: 'Placeholder text',
    onChange: 'Callback with HTML string when content changes',
    className: 'Additional CSS classes',
  },
};

interface RichTextEditorComponent extends React.FC<RichTextEditorProps> {
  Metadata: ComponentMetadata;
}

interface ToolbarButtonProps {
  icon: string;
  label: string;
  isActive?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

const ToolbarButton = ({ icon, label, isActive, disabled, onClick }: ToolbarButtonProps) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={label}
    className={`btn btn-sm btn-ghost ${isActive ? 'bg-base-300' : ''} ${disabled ? 'btn-disabled' : ''}`}
  >
    <Icon icon={icon} className="w-4 h-4" />
  </button>
);

const ToolbarDivider = () => <div className="w-px h-6 bg-base-300 mx-1" />;

// Inline popover for Link URL input
interface LinkPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (url: string) => void;
  buttonRef: React.RefObject<HTMLDivElement | null>;
}

const LinkPopover = ({ isOpen, onClose, onSubmit, buttonRef }: LinkPopoverProps) => {
  const [url, setUrl] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
      setUrl('');
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose, buttonRef]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (url.trim()) {
      onSubmit(url.trim());
      setUrl('');
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div
      ref={popoverRef}
      className="absolute top-full left-0 mt-1 bg-base-100 border border-base-300 rounded-lg shadow-lg p-3 z-50 min-w-[280px]"
    >
      <div className="text-sm font-medium mb-2">Add Link</div>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          ref={inputRef}
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com"
          className="input input-sm input-bordered flex-1"
        />
        <button type="submit" className="btn btn-sm btn-primary">
          Add
        </button>
        <button type="button" onClick={onClose} className="btn btn-sm btn-ghost">
          <Icon icon="mdi:close" className="w-4 h-4" />
        </button>
      </form>
    </div>
  );
};

// Inline popover for Image (URL or Upload)
interface ImagePopoverProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (url: string) => void;
  buttonRef: React.RefObject<HTMLDivElement | null>;
}

const ImagePopover = ({ isOpen, onClose, onSubmit, buttonRef }: ImagePopoverProps) => {
  const [url, setUrl] = useState('');
  const [activeTab, setActiveTab] = useState<'url' | 'upload'>('url');
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen && inputRef.current && activeTab === 'url') {
      inputRef.current.focus();
      setUrl('');
    }
  }, [isOpen, activeTab]);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose, buttonRef]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (url.trim()) {
      onSubmit(url.trim());
      setUrl('');
      onClose();
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        onSubmit(dataUrl);
        onClose();
      };
      reader.readAsDataURL(file);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      ref={popoverRef}
      className="absolute top-full left-0 mt-1 bg-base-100 border border-base-300 rounded-lg shadow-lg p-3 z-50 min-w-[300px]"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-medium">Add Image</div>
        <button type="button" onClick={onClose} className="btn btn-xs btn-ghost btn-circle">
          <Icon icon="mdi:close" className="w-4 h-4" />
        </button>
      </div>

      {/* Tabs */}
      <div className="tabs tabs-boxed mb-3">
        <button
          type="button"
          className={`tab tab-sm flex-1 ${activeTab === 'url' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('url')}
        >
          <Icon icon="mdi:link" className="w-4 h-4 mr-1" />
          URL
        </button>
        <button
          type="button"
          className={`tab tab-sm flex-1 ${activeTab === 'upload' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('upload')}
        >
          <Icon icon="mdi:upload" className="w-4 h-4 mr-1" />
          Upload
        </button>
      </div>

      {/* URL Tab */}
      {activeTab === 'url' && (
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            ref={inputRef}
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/image.jpg"
            className="input input-sm input-bordered flex-1"
          />
          <button type="submit" className="btn btn-sm btn-primary">
            Add
          </button>
        </form>
      )}

      {/* Upload Tab */}
      {activeTab === 'upload' && (
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="btn btn-sm btn-outline w-full gap-2"
          >
            <Icon icon="mdi:folder-open" className="w-4 h-4" />
            Choose Image
          </button>
          <p className="text-xs text-base-content/50 mt-2 text-center">
            Supports JPG, PNG, GIF, WebP
          </p>
        </div>
      )}
    </div>
  );
};

const RichTextEditor: RichTextEditorComponent = ({
  content = '',
  placeholder = 'Start typing...',
  onChange,
  className = '',
}) => {
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false);
  const [imagePopoverOpen, setImagePopoverOpen] = useState(false);
  const linkButtonRef = useRef<HTMLDivElement>(null);
  const imageButtonRef = useRef<HTMLDivElement>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3],
        },
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          class: 'link link-primary',
        },
      }),
      Image.configure({
        HTMLAttributes: {
          class: 'rounded-lg max-w-full',
        },
      }),
      Placeholder.configure({
        placeholder,
      }),
      Underline,
      TextAlign.configure({
        types: ['heading', 'paragraph'],
      }),
    ],
    content,
    onUpdate: ({ editor }) => {
      onChange?.(editor.getHTML());
    },
    editorProps: {
      attributes: {
        class: 'outline-none min-h-[200px] p-4',
      },
    },
  });

  if (!editor) return null;

  const addLink = (url: string) => {
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  const addImage = (url: string) => {
    editor.chain().focus().setImage({ src: url }).run();
  };

  return (
    <div className={`border border-base-300 rounded-lg overflow-hidden bg-base-100 ${className}`}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1 p-2 border-b border-base-300 bg-base-200">
        {/* Text Style */}
        <ToolbarButton
          icon="mdi:format-bold"
          label="Bold"
          isActive={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
        />
        <ToolbarButton
          icon="mdi:format-italic"
          label="Italic"
          isActive={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        />
        <ToolbarButton
          icon="mdi:format-underline"
          label="Underline"
          isActive={editor.isActive('underline')}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
        />
        <ToolbarButton
          icon="mdi:format-strikethrough"
          label="Strikethrough"
          isActive={editor.isActive('strike')}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        />

        <ToolbarDivider />

        {/* Headings */}
        <ToolbarButton
          icon="mdi:format-header-1"
          label="Heading 1"
          isActive={editor.isActive('heading', { level: 1 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        />
        <ToolbarButton
          icon="mdi:format-header-2"
          label="Heading 2"
          isActive={editor.isActive('heading', { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        />
        <ToolbarButton
          icon="mdi:format-header-3"
          label="Heading 3"
          isActive={editor.isActive('heading', { level: 3 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        />

        <ToolbarDivider />

        {/* Lists */}
        <ToolbarButton
          icon="mdi:format-list-bulleted"
          label="Bullet List"
          isActive={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        />
        <ToolbarButton
          icon="mdi:format-list-numbered"
          label="Numbered List"
          isActive={editor.isActive('orderedList')}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        />

        <ToolbarDivider />

        {/* Alignment */}
        <ToolbarButton
          icon="mdi:format-align-left"
          label="Align Left"
          isActive={editor.isActive({ textAlign: 'left' })}
          onClick={() => editor.chain().focus().setTextAlign('left').run()}
        />
        <ToolbarButton
          icon="mdi:format-align-center"
          label="Align Center"
          isActive={editor.isActive({ textAlign: 'center' })}
          onClick={() => editor.chain().focus().setTextAlign('center').run()}
        />
        <ToolbarButton
          icon="mdi:format-align-right"
          label="Align Right"
          isActive={editor.isActive({ textAlign: 'right' })}
          onClick={() => editor.chain().focus().setTextAlign('right').run()}
        />

        <ToolbarDivider />

        {/* Block Elements */}
        <ToolbarButton
          icon="mdi:format-quote-close"
          label="Blockquote"
          isActive={editor.isActive('blockquote')}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        />
        <ToolbarButton
          icon="mdi:code-tags"
          label="Code Block"
          isActive={editor.isActive('codeBlock')}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        />
        <ToolbarButton
          icon="mdi:minus"
          label="Horizontal Rule"
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
        />

        <ToolbarDivider />

        {/* Links & Media */}
        <div ref={linkButtonRef} className="relative">
          <ToolbarButton
            icon="mdi:link"
            label="Add Link"
            isActive={editor.isActive('link') || linkPopoverOpen}
            onClick={() => {
              setImagePopoverOpen(false);
              setLinkPopoverOpen(!linkPopoverOpen);
            }}
          />
          <LinkPopover
            isOpen={linkPopoverOpen}
            onClose={() => setLinkPopoverOpen(false)}
            onSubmit={addLink}
            buttonRef={linkButtonRef}
          />
        </div>
        <ToolbarButton
          icon="mdi:link-off"
          label="Remove Link"
          disabled={!editor.isActive('link')}
          onClick={() => editor.chain().focus().unsetLink().run()}
        />
        <div ref={imageButtonRef} className="relative">
          <ToolbarButton
            icon="mdi:image"
            label="Add Image"
            isActive={imagePopoverOpen}
            onClick={() => {
              setLinkPopoverOpen(false);
              setImagePopoverOpen(!imagePopoverOpen);
            }}
          />
          <ImagePopover
            isOpen={imagePopoverOpen}
            onClose={() => setImagePopoverOpen(false)}
            onSubmit={addImage}
            buttonRef={imageButtonRef}
          />
        </div>

        <ToolbarDivider />

        {/* Undo/Redo */}
        <ToolbarButton
          icon="mdi:undo"
          label="Undo"
          disabled={!editor.can().undo()}
          onClick={() => editor.chain().focus().undo().run()}
        />
        <ToolbarButton
          icon="mdi:redo"
          label="Redo"
          disabled={!editor.can().redo()}
          onClick={() => editor.chain().focus().redo().run()}
        />
      </div>

      {/* Editor Content */}
      <div
        className="
          [&_.ProseMirror]:min-h-[200px]
          [&_.ProseMirror]:p-4
          [&_.ProseMirror]:outline-none

          [&_.ProseMirror_p]:mb-3
          [&_.ProseMirror_h1]:text-3xl [&_.ProseMirror_h1]:font-bold [&_.ProseMirror_h1]:mb-3
          [&_.ProseMirror_h2]:text-2xl [&_.ProseMirror_h2]:font-bold [&_.ProseMirror_h2]:mb-2
          [&_.ProseMirror_h3]:text-xl [&_.ProseMirror_h3]:font-semibold [&_.ProseMirror_h3]:mb-2

          [&_.ProseMirror_ul]:list-disc [&_.ProseMirror_ul]:ml-6 [&_.ProseMirror_ul]:mb-3
          [&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_ol]:ml-6 [&_.ProseMirror_ol]:mb-3
          [&_.ProseMirror_li]:mb-1

          [&_.ProseMirror_blockquote]:border-l-4 [&_.ProseMirror_blockquote]:border-primary [&_.ProseMirror_blockquote]:pl-4 [&_.ProseMirror_blockquote]:py-2 [&_.ProseMirror_blockquote]:my-3 [&_.ProseMirror_blockquote]:bg-base-200 [&_.ProseMirror_blockquote]:rounded-r-lg [&_.ProseMirror_blockquote]:italic

          [&_.ProseMirror_pre]:bg-base-300 [&_.ProseMirror_pre]:p-4 [&_.ProseMirror_pre]:rounded-lg [&_.ProseMirror_pre]:overflow-x-auto [&_.ProseMirror_pre]:mb-3 [&_.ProseMirror_pre]:font-mono

          [&_.ProseMirror_code]:bg-base-200 [&_.ProseMirror_code]:px-1 [&_.ProseMirror_code]:rounded [&_.ProseMirror_code]:font-mono

          [&_.ProseMirror_hr]:border-base-300 [&_.ProseMirror_hr]:my-4

          [&_.ProseMirror_img]:rounded-lg [&_.ProseMirror_img]:max-w-full [&_.ProseMirror_img]:my-3

          [&_.ProseMirror_a]:link [&_.ProseMirror_a]:link-primary

          [&_.ProseMirror_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.ProseMirror_.is-editor-empty:first-child::before]:text-base-content/40 [&_.ProseMirror_.is-editor-empty:first-child::before]:float-left [&_.ProseMirror_.is-editor-empty:first-child::before]:pointer-events-none [&_.ProseMirror_.is-editor-empty:first-child::before]:h-0
        "
      >
        <EditorContent editor={editor} />
      </div>
    </div>
  );
};

RichTextEditor.Metadata = METADATA;

export default RichTextEditor;
