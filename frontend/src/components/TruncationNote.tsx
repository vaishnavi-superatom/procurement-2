import React from 'react';
import { Icon } from '@iconify/react';

/**
 * Discloses that a component is rendering a capped slice of its dataset.
 * The counts are stamped by the SDK at build time (`_rowsRendered`/`_rowsTotal`)
 * because that is the last place the uncapped count is known — the fetched
 * payload is already truncated. See backend/docs/COMPONENT-GENERATION-V2.md §2.7.
 */
const TruncationNote: React.FC<{ rendered?: number; total?: number }> = ({ rendered, total }) => {
  if (!rendered || !total || rendered >= total) return null;
  return (
    <p className="text-xs opacity-60 flex items-center gap-1 mt-0.5">
      <Icon icon="mdi:information-outline" className="w-3.5 h-3.5 flex-shrink-0" />
      Showing {rendered.toLocaleString()} of {total.toLocaleString()}
    </p>
  );
};

export default TruncationNote;
