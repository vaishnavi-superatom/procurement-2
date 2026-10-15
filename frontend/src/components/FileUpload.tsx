import React, { useRef, useState, useId, useEffect } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../types';

type FileType = 'image' | 'pdf';

interface UploadedFile {
  file: File;
  previewUrl: string;
}

interface FileUploadProps {
  fileType?: FileType;
  multiple?: boolean;
  maxSize?: number; // in MB
  onUpload?: (files: File[]) => void;
  onRemove?: (file: File) => void;
  disabled?: boolean;
  className?: string;
}

const FILE_CONFIG: Record<FileType, { accept: string; icon: string; label: string }> = {
  image: {
    accept: 'image/png,image/jpeg,image/gif,image/webp',
    icon: 'mdi:image-outline',
    label: 'images',
  },
  pdf: {
    accept: 'application/pdf',
    icon: 'mdi:file-pdf-box',
    label: 'PDF files',
  },
};

const METADATA: ComponentMetadata = {
  id: 'generic-file-upload',
  name: 'FileUpload',
  displayName: 'Upload files (images or PDFs)',
  isDisplayComp: true,
  type: 'FileUpload',
  description: 'A drag & drop file upload component. Supports image and PDF file types with preview.',
  category: 'input',
  keywords: ['upload', 'file', 'image', 'pdf', 'drag', 'drop'],
  props: {
    fileType: '"image" (default) | "pdf"',
    multiple: 'Allow multiple files (default: false)',
    maxSize: 'Max file size in MB (default: 10)',
    onUpload: 'Callback when files are uploaded',
    onRemove: 'Callback when a file is removed',
    disabled: 'Disable the upload (default: false)',
    className: 'Additional CSS classes',
  },
};

interface FileUploadComponent extends React.FC<FileUploadProps> {
  Metadata: ComponentMetadata;
}

const FileUpload: FileUploadComponent = ({
  fileType = 'image',
  multiple = false,
  maxSize = 10,
  onUpload,
  onRemove,
  disabled = false,
  className = '',
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDialogElement>(null);
  const uniqueId = useId().replace(/:/g, '');
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<UploadedFile | null>(null);

  const config = FILE_CONFIG[fileType];

  // Cleanup object URLs on unmount
  useEffect(() => {
    return () => {
      files.forEach((f) => URL.revokeObjectURL(f.previewUrl));
    };
  }, []);

  const validateFile = (file: File): boolean => {
    // Check file type
    const acceptedTypes = config.accept.split(',');
    if (!acceptedTypes.some((type) => file.type === type || file.type.startsWith(type.replace('/*', '/')))) {
      setError(`Invalid file type. Please upload ${config.label}.`);
      return false;
    }

    // Check file size
    if (file.size > maxSize * 1024 * 1024) {
      setError(`File too large. Maximum size is ${maxSize}MB.`);
      return false;
    }

    setError(null);
    return true;
  };

  const handleFiles = (newFiles: FileList | null) => {
    if (!newFiles || disabled) return;

    const validFiles: UploadedFile[] = [];
    Array.from(newFiles).forEach((file) => {
      if (validateFile(file)) {
        validFiles.push({
          file,
          previewUrl: URL.createObjectURL(file),
        });
      }
    });

    if (validFiles.length > 0) {
      const updatedFiles = multiple ? [...files, ...validFiles] : validFiles;
      setFiles(updatedFiles);
      onUpload?.(validFiles.map((f) => f.file));
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleFiles(e.dataTransfer.files);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!disabled) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleClick = () => {
    if (!disabled) inputRef.current?.click();
  };

  const handleRemove = (uploadedFile: UploadedFile) => {
    URL.revokeObjectURL(uploadedFile.previewUrl);
    setFiles(files.filter((f) => f !== uploadedFile));
    onRemove?.(uploadedFile.file);
  };

  const openPreview = (uploadedFile: UploadedFile) => {
    setPreviewFile(uploadedFile);
    modalRef.current?.showModal();
  };

  const closePreview = () => {
    modalRef.current?.close();
    setPreviewFile(null);
  };

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className={`w-full ${className}`}>
      {/* Dropzone */}
      <div
        onClick={handleClick}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={`
          border-2 border-dashed rounded-box p-8 text-center cursor-pointer transition-all
          ${isDragging ? 'border-primary bg-primary/5' : 'border-base-300 hover:border-primary/50'}
          ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
        `}
      >
        <input
          ref={inputRef}
          id={uniqueId}
          type="file"
          accept={config.accept}
          multiple={multiple}
          onChange={(e) => handleFiles(e.target.files)}
          disabled={disabled}
          className="hidden"
        />
        <Icon icon={config.icon} className="w-12 h-12 mx-auto text-base-content/40 mb-3" />
        <p className="text-base-content/70 mb-1">
          <span className="text-primary font-medium">Click to upload</span> or drag and drop
        </p>
        <p className="text-sm text-base-content/50">
          {config.label.charAt(0).toUpperCase() + config.label.slice(1)} up to {maxSize}MB
          {multiple && ' (multiple allowed)'}
        </p>
      </div>

      {/* Error Message */}
      {error && (
        <div className="alert alert-error mt-3 py-2">
          <Icon icon="mdi:alert-circle" className="w-5 h-5" />
          <span className="text-sm">{error}</span>
        </div>
      )}

      {/* File List */}
      {files.length > 0 && (
        <div className="mt-4 space-y-2">
          {files.map((uploadedFile, index) => (
            <div
              key={`${uploadedFile.file.name}-${index}`}
              className="flex items-center gap-3 p-3 bg-base-200 rounded-lg"
            >
              {/* Preview or Icon - Clickable */}
              <button
                onClick={() => openPreview(uploadedFile)}
                className="flex-shrink-0 hover:opacity-80 transition-opacity"
                title="Click to preview"
              >
                {fileType === 'image' ? (
                  <img
                    src={uploadedFile.previewUrl}
                    alt={uploadedFile.file.name}
                    className="w-12 h-12 object-cover rounded cursor-pointer"
                  />
                ) : (
                  <div className="w-12 h-12 bg-error/10 rounded flex items-center justify-center cursor-pointer">
                    <Icon icon="mdi:file-pdf-box" className="w-7 h-7 text-error" />
                  </div>
                )}
              </button>

              {/* File Info */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{uploadedFile.file.name}</p>
                <p className="text-xs text-base-content/50">{formatSize(uploadedFile.file.size)}</p>
              </div>

              {/* Preview Button */}
              <button
                onClick={() => openPreview(uploadedFile)}
                className="btn btn-ghost btn-sm btn-circle"
                aria-label="Preview file"
                title="Preview"
              >
                <Icon icon="mdi:eye-outline" className="w-4 h-4" />
              </button>

              {/* Remove Button */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleRemove(uploadedFile);
                }}
                className="btn btn-ghost btn-sm btn-circle text-error"
                aria-label="Remove file"
              >
                <Icon icon="mdi:close" className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Preview Modal */}
      <dialog ref={modalRef} className="modal">
        <div className="modal-box max-w-4xl max-h-[85vh] p-0">
          {/* Modal Header */}
          <div className="flex items-center justify-between p-4 border-b border-base-300">
            <h3 className="font-semibold truncate pr-4">
              {previewFile?.file.name}
            </h3>
            <button
              onClick={closePreview}
              className="btn btn-ghost btn-sm btn-circle"
            >
              <Icon icon="mdi:close" className="w-5 h-5" />
            </button>
          </div>

          {/* Modal Content */}
          <div className="p-4 overflow-auto max-h-[calc(85vh-80px)]">
            {previewFile && fileType === 'image' && (
              <img
                src={previewFile.previewUrl}
                alt={previewFile.file.name}
                className="w-full h-auto rounded"
              />
            )}
            {previewFile && fileType === 'pdf' && (
              <iframe
                src={previewFile.previewUrl}
                title={previewFile.file.name}
                className="w-full h-[70vh] rounded border-0"
              />
            )}
          </div>
        </div>
        <form method="dialog" className="modal-backdrop">
          <button onClick={closePreview}>close</button>
        </form>
      </dialog>
    </div>
  );
};

FileUpload.Metadata = METADATA;

export default FileUpload;
