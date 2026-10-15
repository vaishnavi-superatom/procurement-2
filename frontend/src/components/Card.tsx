import React from 'react';
import type { ComponentMetadata } from '../types';

interface CardProps {
  /**
   * Image URL for the card
   */
  image?: string;
  /**
   * Alt text for the image
   */
  imageAlt?: string;
  /**
   * Card title
   */
  title?: string;
  /**
   * Badge text to show next to title (e.g., "NEW")
   */
  titleBadge?: string;
  /**
   * Badge color variant
   */
  titleBadgeVariant?: 'primary' | 'secondary' | 'accent' | 'info' | 'success' | 'warning' | 'error';
  /**
   * Card description/body text
   */
  description?: string;
  /**
   * Array of tags to display
   */
  tags?: string[];
  /**
   * Button text - if provided, shows a button instead of tags
   */
  buttonText?: string;
  /**
   * Button click handler
   */
  onButtonClick?: () => void;
  /**
   * Button color variant
   */
  buttonVariant?: 'primary' | 'secondary' | 'accent' | 'info' | 'success' | 'warning' | 'error';
  /**
   * Additional CSS classes for the card container
   */
  className?: string;
  /**
   * SA Runtime object for component interactions
   */
  SA_RUNTIME?: any;
}

const METADATA: ComponentMetadata = {
  id: 'generic-card',
  name: 'Card',
  displayName: 'Display a card with image and content',
  isDisplayComp: true,
  type: 'Card',
  description: 'A generic card component using DaisyUI. Displays an image, title with optional badge, description, and either tags or a CTA button.',
  category: 'display',
  keywords: ['card', 'image', 'display', 'tags', 'button', 'content'],
  props: {
    image: 'URL of the image to display in the card figure section',
    imageAlt: 'Alt text for the image (default: "Card image")',
    title: 'Card title text',
    titleBadge: 'Optional badge text to show next to title (e.g., "NEW", "SALE")',
    titleBadgeVariant: 'Badge color variant: primary | secondary | accent | info | success | warning | error',
    description: 'Card body/description text',
    tags: 'Array of tag strings to display as outline badges (only shown if no buttonText)',
    buttonText: 'If provided, shows a CTA button instead of tags',
    onButtonClick: 'Click handler function for the button',
    buttonVariant: 'Button color variant: primary | secondary | accent | info | success | warning | error',
    className: 'Additional CSS classes for the card container'
  }
};

interface CardComponent extends React.FC<CardProps> {
  Metadata: ComponentMetadata;
}

const Card: React.FC<CardProps> = ({
  image = 'https://img.daisyui.com/images/stock/photo-1606107557195-0e29a4b5b4aa.webp',
  imageAlt = 'Card image',
  title = 'Card Title',
  titleBadge,
  titleBadgeVariant = 'secondary',
  description = 'A card component has a figure, a body part, and inside body there are title and actions parts',
  tags,
  buttonText,
  onButtonClick,
  buttonVariant = 'primary',
  className = '',
  SA_RUNTIME = {}
}) => {
  const badgeVariantClass = titleBadge ? `badge-${titleBadgeVariant}` : '';
  const buttonVariantClass = buttonText ? `btn-${buttonVariant}` : '';

  return (
    <div className={`card bg-base-100 w-96 shadow-sm ${className}`}>
      {image && (
        <figure>
          <img src={image} alt={imageAlt} />
        </figure>
      )}
      <div className="card-body">
        {title && (
          <h2 className="card-title">
            {title}
            {titleBadge && (
              <div className={`badge ${badgeVariantClass}`}>{titleBadge}</div>
            )}
          </h2>
        )}
        {description && <p>{description}</p>}

        {/* Show button if buttonText is provided */}
        {buttonText && (
          <div className="card-actions justify-end">
            <button
              className={`btn ${buttonVariantClass}`}
              onClick={onButtonClick}
            >
              {buttonText}
            </button>
          </div>
        )}

        {/* Show tags if tags are provided and no button */}
        {!buttonText && tags && tags.length > 0 && (
          <div className="card-actions justify-end">
            {tags.map((tag, index) => (
              <div key={index} className="badge badge-outline">{tag}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

(Card as CardComponent).Metadata = METADATA;

export default Card;
