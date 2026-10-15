import React, { useId, useState, useRef, useEffect } from 'react';
import type { ComponentMetadata } from '../types';

interface CarouselItem {
  image?: string;
  alt?: string;
  content?: React.ReactNode;
}

interface CarouselProps {
  items?: CarouselItem[];
  orientation?: 'horizontal' | 'vertical';
  showNavButtons?: boolean;
  showIndicators?: boolean;
  indicatorType?: 'bullets' | 'numbers';
  alignment?: 'center' | 'start' | 'end';
  fullWidth?: boolean;
  height?: string;
  bgColor?: string;
  spacing?: string;
  padding?: string;
  className?: string;
  itemClassName?: string;
  SA_RUNTIME?: any;
}

const DEFAULT_ITEMS: CarouselItem[] = [
  { image: 'https://img.daisyui.com/images/stock/photo-1559703248-dcaaec9fab78.webp', alt: 'Carousel image 1' },
  { image: 'https://img.daisyui.com/images/stock/photo-1565098772267-60af42b81ef2.webp', alt: 'Carousel image 2' },
  { image: 'https://img.daisyui.com/images/stock/photo-1572635148818-ef6fd45eb394.webp', alt: 'Carousel image 3' },
  { image: 'https://img.daisyui.com/images/stock/photo-1494253109108-2e30c049369b.webp', alt: 'Carousel image 4' },
  { image: 'https://img.daisyui.com/images/stock/photo-1550258987-190a2d41a8ba.webp', alt: 'Carousel image 5' },
];

const METADATA: ComponentMetadata = {
  id: 'generic-carousel',
  name: 'Carousel',
  displayName: 'Display a carousel of images or content',
  isDisplayComp: true,
  type: 'Carousel',
  description: 'A flexible carousel component using DaisyUI. Supports horizontal/vertical orientation, navigation buttons, and indicators.',
  category: 'display',
  keywords: ['carousel', 'slider', 'images', 'gallery', 'slideshow'],
  props: {
    items: 'Array of carousel items with image/alt/content',
    orientation: '"horizontal" (default) or "vertical"',
    showNavButtons: 'Show prev/next buttons (default: false)',
    showIndicators: 'Show indicator buttons (default: false)',
    indicatorType: '"bullets" or "numbers" (default: "bullets")',
    fullWidth: 'Full width items (default: false)',
    className: 'Additional CSS classes'
  }
};

interface CarouselComponent extends React.FC<CarouselProps> {
  Metadata: ComponentMetadata;
}

const Carousel: React.FC<CarouselProps> = ({
  items = DEFAULT_ITEMS,
  orientation = 'horizontal',
  showNavButtons = false,
  showIndicators = false,
  indicatorType = 'bullets',
  alignment = 'center',
  fullWidth = false,
  height = 'h-96',
  bgColor = '',
  spacing = 'space-x-4',
  padding = 'p-4',
  className = '',
  itemClassName = '',
  SA_RUNTIME = {}
}) => {
  const uniqueId = useId().replace(/:/g, '');
  const [activeIndex, setActiveIndex] = useState(0);
  const carouselRef = useRef<HTMLDivElement>(null);

  // Track active slide using Intersection Observer
  useEffect(() => {
    const carousel = carouselRef.current;
    if (!carousel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const slideId = entry.target.id;
            const index = parseInt(slideId.replace(`${uniqueId}-slide`, ''));
            if (!isNaN(index)) {
              setActiveIndex(index);
            }
          }
        });
      },
      {
        root: carousel,
        threshold: 0.5,
      }
    );

    const slides = carousel.querySelectorAll('.carousel-item');
    slides.forEach((slide) => observer.observe(slide));

    return () => observer.disconnect();
  }, [uniqueId, items.length]);

  // Navigate to slide
  const goToSlide = (index: number) => {
    const slide = document.getElementById(`${uniqueId}-slide${index}`);
    if (slide) {
      slide.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
    }
  };

  const getPrevIndex = (index: number) => (index === 0 ? items.length - 1 : index - 1);
  const getNextIndex = (index: number) => (index === items.length - 1 ? 0 : index + 1);

  // Build carousel classes
  const carouselClasses = [
    'carousel',
    orientation === 'vertical' ? 'carousel-vertical' : '',
    alignment === 'center' ? 'carousel-center' : '',
    alignment === 'start' ? 'carousel-start' : '',
    alignment === 'end' ? 'carousel-end' : '',
    fullWidth ? 'w-full' : '',
    orientation === 'vertical' ? height : '',
    bgColor,
    'rounded-box',
    orientation === 'horizontal' && !fullWidth ? spacing : '',
    !showNavButtons && !showIndicators ? padding : '',
    className
  ].filter(Boolean).join(' ');

  const renderItemContent = (item: CarouselItem) => {
    if (item.content) return item.content;
    if (item.image) {
      return (
        <img
          src={item.image}
          alt={item.alt || 'Carousel image'}
          className={fullWidth ? 'w-full' : 'rounded-box'}
        />
      );
    }
    return null;
  };

  return (
    <div className={showNavButtons || showIndicators ? className : ''}>
      <div ref={carouselRef} className={carouselClasses}>
        {items.map((item, index) => (
          <div
            key={index}
            id={`${uniqueId}-slide${index}`}
            className={`carousel-item ${fullWidth ? 'relative w-full' : ''} ${orientation === 'vertical' ? 'h-full' : ''} ${itemClassName}`}
          >
            {renderItemContent(item)}

            {/* DaisyUI Nav Buttons - inside each slide */}
            {showNavButtons && fullWidth && (
              <div className="absolute left-5 right-5 top-1/2 flex -translate-y-1/2 transform justify-between">
                <a href={`#${uniqueId}-slide${getPrevIndex(index)}`} className="btn btn-circle">❮</a>
                <a href={`#${uniqueId}-slide${getNextIndex(index)}`} className="btn btn-circle">❯</a>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* DaisyUI Indicators */}
      {showIndicators && (
        <div className="flex w-full justify-center gap-2 py-2">
          {items.map((_, index) => (
            indicatorType === 'numbers' ? (
              <a
                key={index}
                href={`#${uniqueId}-slide${index}`}
                className={`btn btn-xs ${activeIndex === index ? 'btn-active' : ''}`}
              >
                {index + 1}
              </a>
            ) : (
              <button
                key={index}
                onClick={() => goToSlide(index)}
                className={`btn btn-xs btn-circle ${activeIndex === index ? 'btn-primary' : 'btn-ghost'}`}
                aria-label={`Go to slide ${index + 1}`}
              >
                ●
              </button>
            )
          ))}
        </div>
      )}
    </div>
  );
};

(Carousel as CarouselComponent).Metadata = METADATA;

export default Carousel;
