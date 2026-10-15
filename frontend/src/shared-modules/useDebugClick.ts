import { useCallback, useState } from 'react';

/**
 * Alt+Click-to-inspect, standalone version of the same mechanism
 * MultiComponentContainer already wires up for components it hosts (see its
 * handleDebugClick) — this lets a component open the same DebugPropsModal
 * when it's rendered on its own (e.g. directly on a GridStack dashboard),
 * not just when wrapped by MultiComponentContainer.
 */
export function useDebugClick() {
  const [isDebugModalOpen, setIsDebugModalOpen] = useState(false);

  const handleDebugClick = useCallback((e: React.MouseEvent) => {
    if (e.altKey && localStorage.getItem('debug') === 'true') {
      e.preventDefault();
      e.stopPropagation();
      setIsDebugModalOpen(true);
    }
  }, []);

  const closeDebugModal = useCallback(() => setIsDebugModalOpen(false), []);

  return { isDebugModalOpen, handleDebugClick, closeDebugModal };
}
