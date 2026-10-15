import React from 'react';
import { Icon } from '@iconify/react';
import { COLORS, TYPOGRAPHY, SHADOWS } from '../../design-system/tokens';

interface PlaceholderPageProps {
  icon: string;
  title: string;
  description: string;
}

const PlaceholderPage: React.FC<PlaceholderPageProps> = ({ icon, title, description }) => (
  <div
    className="w-full flex flex-col items-center justify-center text-center py-24 px-8 rounded-2xl"
    style={{
      backgroundColor: COLORS.white,
      border: `1px solid ${COLORS.borderGray}`,
      boxShadow: SHADOWS.card,
      fontFamily: TYPOGRAPHY.fontFamily.primary,
    }}
  >
    <div
      className="w-16 h-16 rounded-xl flex items-center justify-center mb-5"
      style={{ backgroundColor: '#E6F5F3' }}
    >
      <Icon icon={icon} className="w-8 h-8" style={{ color: '#0F6B64' }} />
    </div>
    <h2 className="text-xl font-semibold mb-2" style={{ color: COLORS.text.primary }}>
      {title}
    </h2>
    <p className="text-sm max-w-md" style={{ color: COLORS.text.secondary }}>
      {description}
    </p>
    <span
      className="mt-5 inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold"
      style={{ backgroundColor: COLORS.lightGray, color: COLORS.text.secondary }}
    >
      Coming soon
    </span>
  </div>
);

export default PlaceholderPage;
