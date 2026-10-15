import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../types';

interface GalleryImage {
  src: string;
  thumbnail?: string;
  alt?: string;
  caption?: string;
}

type Gap = 'sm' | 'md' | 'lg';
type RowHeight = 'sm' | 'md' | 'lg';
type Columns = 2 | 3 | 4 | 5 | 6;
type Layout = 'vertical' | 'horizontal';

interface GalleryProps {
  images: GalleryImage[];
  layout?: Layout;
  columns?: Columns;
  rowHeight?: RowHeight;
  gap?: Gap;
  className?: string;
}

const METADATA: ComponentMetadata = {
  id: 'generic-gallery',
  name: 'Gallery',
  displayName: 'Photo gallery with lightbox',
  isDisplayComp: true,
  type: 'ImageGallery',
  description: 'A masonry photo gallery with vertical (Pinterest-style) or horizontal layout, lightbox modal with zoom.',
  category: 'display',
  keywords: ['gallery', 'images', 'photos', 'lightbox', 'masonry', 'pinterest', 'zoom'],
  props: {
    images: 'Array of { src, thumbnail?, alt?, caption? }',
    layout: '"vertical" (default) | "horizontal"',
    columns: '2 | 3 (default) | 4 | 5 | 6 (vertical layout)',
    rowHeight: '"sm" (150px) | "md" (200px, default) | "lg" (250px) (horizontal layout)',
    gap: '"sm" | "md" (default) | "lg"',
    className: 'Additional CSS classes',
  },
};

interface GalleryComponent extends React.FC<GalleryProps> {
  Metadata: ComponentMetadata;
}

interface ImageDimensions {
  width: number;
  height: number;
  loaded: boolean;
}

const DEFAULT_IMAGES: GalleryImage[] = [
  { src: 'https://picsum.photos/800/600?random=1', caption: 'Landscape' },
  { src: 'https://picsum.photos/600/800?random=2', caption: 'Portrait' },
  { src: 'https://picsum.photos/1200/800?random=3', caption: 'Wide' },
  { src: 'https://picsum.photos/800/800?random=4', caption: 'Square' },
  { src: 'https://picsum.photos/1000/600?random=5', caption: 'Panoramic' },
  { src: 'https://picsum.photos/700/900?random=6', caption: 'Tall' },
];

const Gallery: GalleryComponent = ({
  images = DEFAULT_IMAGES,
  layout = 'vertical',
  columns = 3,
  rowHeight = 'md',
  gap = 'md',
  className = '',
}) => {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [imageDimensions, setImageDimensions] = useState<Map<string, ImageDimensions>>(new Map());

  // Zoom state
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const imageContainerRef = useRef<HTMLDivElement>(null);

  const MIN_ZOOM = 1;
  const MAX_ZOOM = 4;
  const ZOOM_STEP = 0.5;

  // Reset zoom when changing images or closing lightbox
  const resetZoom = useCallback(() => {
    setZoom(1);
    setPosition({ x: 0, y: 0 });
  }, []);

  // Preload images and get their dimensions
  useEffect(() => {
    images.forEach((image) => {
      const src = image.thumbnail || image.src;

      // Skip if already loaded
      if (imageDimensions.get(src)?.loaded) return;

      const img = new Image();
      img.onload = () => {
        setImageDimensions((prev) => {
          const newMap = new Map(prev);
          newMap.set(src, {
            width: img.naturalWidth,
            height: img.naturalHeight,
            loaded: true,
          });
          return newMap;
        });
      };
      img.src = src;
    });
  }, [images, imageDimensions]);

  const gapClasses: Record<Gap, string> = {
    sm: 'gap-1',
    md: 'gap-2',
    lg: 'gap-4',
  };

  const gapValues: Record<Gap, number> = {
    sm: 4,
    md: 8,
    lg: 16,
  };

  const rowHeightValues: Record<RowHeight, number> = {
    sm: 150,
    md: 200,
    lg: 250,
  };

  // Generate CSS class name for responsive grid columns
  const getResponsiveGridClass = (cols: Columns): string => {
    return `gallery-grid-${cols}`;
  };

  const openLightbox = (index: number) => {
    setCurrentIndex(index);
    setLightboxOpen(true);
    resetZoom();
  };

  const closeLightbox = () => {
    setLightboxOpen(false);
    resetZoom();
  };

  const goToPrevious = useCallback(() => {
    setCurrentIndex((prev) => (prev === 0 ? images.length - 1 : prev - 1));
    resetZoom();
  }, [images.length, resetZoom]);

  const goToNext = useCallback(() => {
    setCurrentIndex((prev) => (prev === images.length - 1 ? 0 : prev + 1));
    resetZoom();
  }, [images.length, resetZoom]);

  // Zoom handlers
  const handleZoomIn = useCallback(() => {
    setZoom((prev) => Math.min(prev + ZOOM_STEP, MAX_ZOOM));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom((prev) => {
      const newZoom = Math.max(prev - ZOOM_STEP, MIN_ZOOM);
      if (newZoom === MIN_ZOOM) {
        setPosition({ x: 0, y: 0 });
      }
      return newZoom;
    });
  }, []);

  // Mouse wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    if (e.deltaY < 0) {
      handleZoomIn();
    } else {
      handleZoomOut();
    }
  }, [handleZoomIn, handleZoomOut]);

  // Double click to toggle zoom
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (zoom > MIN_ZOOM) {
      resetZoom();
    } else {
      setZoom(2);
    }
  }, [zoom, resetZoom]);

  // Drag to pan when zoomed
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (zoom > MIN_ZOOM) {
      e.preventDefault();
      setIsDragging(true);
      setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
    }
  }, [zoom, position]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging && zoom > MIN_ZOOM) {
      const newX = e.clientX - dragStart.x;
      const newY = e.clientY - dragStart.y;
      setPosition({ x: newX, y: newY });
    }
  }, [isDragging, zoom, dragStart]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Touch handlers for mobile
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (zoom > MIN_ZOOM && e.touches.length === 1) {
      const touch = e.touches[0];
      setIsDragging(true);
      setDragStart({ x: touch.clientX - position.x, y: touch.clientY - position.y });
    }
  }, [zoom, position]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (isDragging && zoom > MIN_ZOOM && e.touches.length === 1) {
      const touch = e.touches[0];
      const newX = touch.clientX - dragStart.x;
      const newY = touch.clientY - dragStart.y;
      setPosition({ x: newX, y: newY });
    }
  }, [isDragging, zoom, dragStart]);

  const handleTouchEnd = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Keyboard navigation
  useEffect(() => {
    if (!lightboxOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') goToPrevious();
      if (e.key === 'ArrowRight') goToNext();
      if (e.key === '+' || e.key === '=') handleZoomIn();
      if (e.key === '-') handleZoomOut();
      if (e.key === '0') resetZoom();
    };

    document.addEventListener('keydown', handleKeyDown);
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [lightboxOpen, goToPrevious, goToNext, handleZoomIn, handleZoomOut, resetZoom]);

  const currentImage = images[currentIndex];
  const height = rowHeightValues[rowHeight];

  // Calculate width based on image aspect ratio (for horizontal layout)
  const getImageWidth = (image: GalleryImage): number => {
    const src = image.thumbnail || image.src;
    const dims = imageDimensions.get(src);
    if (!dims || !dims.loaded) return height;
    const aspectRatio = dims.width / dims.height;
    return Math.round(height * aspectRatio);
  };

  // Distribute images into columns for vertical layout (shortest column first)
  const distributeImages = () => {
    const columnHeights: number[] = Array(columns).fill(0);
    const columnImages: { image: GalleryImage; index: number }[][] = Array.from(
      { length: columns },
      () => []
    );

    images.forEach((image, index) => {
      const src = image.thumbnail || image.src;
      const dims = imageDimensions.get(src);

      // Calculate relative height based on aspect ratio
      const aspectRatio = dims?.loaded ? dims.width / dims.height : 1;
      const relativeHeight = 1 / aspectRatio;

      // Find the shortest column
      const shortestColumn = columnHeights.indexOf(Math.min(...columnHeights));

      columnImages[shortestColumn].push({ image, index });
      columnHeights[shortestColumn] += relativeHeight + gapValues[gap] / 100;
    });

    return columnImages;
  };

  const columnImages = distributeImages();

  return (
    <>
      {/* Dynamic CSS for responsive grid columns */}
      <style>{`
        .gallery-grid-2 {
          grid-template-columns: repeat(2, 1fr);
        }

        .gallery-grid-3 {
          grid-template-columns: repeat(2, 1fr);
        }
        @media (min-width: 640px) {
          .gallery-grid-3 {
            grid-template-columns: repeat(3, 1fr);
          }
        }

        .gallery-grid-4 {
          grid-template-columns: repeat(2, 1fr);
        }
        @media (min-width: 640px) {
          .gallery-grid-4 {
            grid-template-columns: repeat(3, 1fr);
          }
        }
        @media (min-width: 768px) {
          .gallery-grid-4 {
            grid-template-columns: repeat(4, 1fr);
          }
        }

        .gallery-grid-5 {
          grid-template-columns: repeat(2, 1fr);
        }
        @media (min-width: 640px) {
          .gallery-grid-5 {
            grid-template-columns: repeat(3, 1fr);
          }
        }
        @media (min-width: 768px) {
          .gallery-grid-5 {
            grid-template-columns: repeat(4, 1fr);
          }
        }
        @media (min-width: 1024px) {
          .gallery-grid-5 {
            grid-template-columns: repeat(5, 1fr);
          }
        }

        .gallery-grid-6 {
          grid-template-columns: repeat(2, 1fr);
        }
        @media (min-width: 640px) {
          .gallery-grid-6 {
            grid-template-columns: repeat(3, 1fr);
          }
        }
        @media (min-width: 768px) {
          .gallery-grid-6 {
            grid-template-columns: repeat(4, 1fr);
          }
        }
        @media (min-width: 1024px) {
          .gallery-grid-6 {
            grid-template-columns: repeat(6, 1fr);
          }
        }
      `}</style>

      {layout === 'vertical' ? (
        /* Vertical Masonry (Pinterest-style) */
        <div className={`grid ${getResponsiveGridClass(columns)} ${gapClasses[gap]} ${className}`}>
          {columnImages.map((column, colIndex) => (
            <div key={colIndex} className={`flex flex-col ${gapClasses[gap]}`}>
              {column.map(({ image, index }) => {
                const src = image.thumbnail || image.src;
                const dims = imageDimensions.get(src);

                return (
                  <button
                    key={index}
                    onClick={() => openLightbox(index)}
                    className="overflow-hidden cursor-pointer group/gallery-item w-full transition-opacity duration-300"
                    style={{ opacity: dims?.loaded ? 1 : 0.5 }}
                  >
                    <img
                      src={src}
                      alt={image.alt || `Image ${index + 1}`}
                      className="w-full h-auto object-cover transition-transform duration-300 group-hover/gallery-item:scale-105"
                    />
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : (
        /* Horizontal Masonry */
        <div className={`flex flex-wrap ${gapClasses[gap]} ${className}`}>
          {images.map((image, index) => {
            const src = image.thumbnail || image.src;
            const dims = imageDimensions.get(src);
            const width = getImageWidth(image);

            return (
              <button
                key={index}
                onClick={() => openLightbox(index)}
                className="overflow-hidden cursor-pointer group/gallery-item flex-shrink-0 transition-opacity duration-300"
                style={{
                  height: `${height}px`,
                  width: dims?.loaded ? `${width}px` : `${height}px`,
                  opacity: dims?.loaded ? 1 : 0.5,
                }}
              >
                <img
                  src={src}
                  alt={image.alt || `Image ${index + 1}`}
                  className="w-full h-full object-cover transition-transform duration-300 group-hover/gallery-item:scale-105"
                />
              </button>
            );
          })}
        </div>
      )}

      {/* Lightbox Modal */}
      {lightboxOpen && (
        <div
          className="fixed inset-0 bg-black/90 flex items-center justify-center"
          style={{ zIndex: 9999 }}
          onClick={closeLightbox}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          {/* Close Button */}
          <button
            onClick={closeLightbox}
            className="absolute top-4 right-4 text-white/70 hover:text-white z-20"
          >
            <Icon icon="mdi:close" className="w-8 h-8" />
          </button>

          {/* Zoom Controls */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/50 rounded-full px-4 py-2 z-20">
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleZoomOut();
              }}
              disabled={zoom <= MIN_ZOOM}
              className="text-white/70 hover:text-white disabled:text-white/30 disabled:cursor-not-allowed"
            >
              <Icon icon="mdi:minus" className="w-6 h-6" />
            </button>
            <span className="text-white text-sm min-w-[3rem] text-center">
              {Math.round(zoom * 100)}%
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleZoomIn();
              }}
              disabled={zoom >= MAX_ZOOM}
              className="text-white/70 hover:text-white disabled:text-white/30 disabled:cursor-not-allowed"
            >
              <Icon icon="mdi:plus" className="w-6 h-6" />
            </button>
            {zoom > MIN_ZOOM && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  resetZoom();
                }}
                className="text-white/70 hover:text-white ml-2"
                title="Reset zoom"
              >
                <Icon icon="mdi:fit-to-screen" className="w-5 h-5" />
              </button>
            )}
          </div>

          {/* Previous Button */}
          {images.length > 1 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                goToPrevious();
              }}
              className="absolute left-4 top-1/2 -translate-y-1/2 text-white/70 hover:text-white z-20"
            >
              <Icon icon="mdi:chevron-left" className="w-12 h-12" />
            </button>
          )}

          {/* Image Container */}
          <div
            ref={imageContainerRef}
            className="max-w-[90vw] max-h-[85vh] flex flex-col items-center overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            onWheel={handleWheel}
            onDoubleClick={handleDoubleClick}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            style={{ cursor: zoom > MIN_ZOOM ? (isDragging ? 'grabbing' : 'grab') : 'zoom-in' }}
          >
            <img
              src={currentImage.src}
              alt={currentImage.alt || `Image ${currentIndex + 1}`}
              className="max-w-full max-h-[75vh] object-contain select-none"
              style={{
                transform: `scale(${zoom}) translate(${position.x / zoom}px, ${position.y / zoom}px)`,
                transition: isDragging ? 'none' : 'transform 0.2s ease-out',
              }}
              draggable={false}
            />
          </div>

          {/* Caption & Counter */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-center text-white z-20">
            {currentImage.caption && (
              <p className="text-lg mb-1">{currentImage.caption}</p>
            )}
            <p className="text-sm text-white/60">
              {currentIndex + 1} / {images.length}
              {zoom > MIN_ZOOM && ' • Double-click or scroll to zoom'}
            </p>
          </div>

          {/* Next Button */}
          {images.length > 1 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                goToNext();
              }}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-white/70 hover:text-white z-20"
            >
              <Icon icon="mdi:chevron-right" className="w-12 h-12" />
            </button>
          )}
        </div>
      )}
    </>
  );
};

Gallery.Metadata = METADATA;

export default Gallery;
