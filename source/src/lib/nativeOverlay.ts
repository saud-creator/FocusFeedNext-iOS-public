import { useEffect, useRef } from 'react';
const owners = new Set<symbol>();
export function isOverlayActive() { return owners.size > 0; }
export function useNativeOverlay(active: boolean) {
  const owner = useRef(Symbol());
  useEffect(() => {
    if (active) owners.add(owner.current); else owners.delete(owner.current);
    window.dispatchEvent(new CustomEvent('ffn-fullscreen', { detail: isOverlayActive() }));
    const id = owner.current;
    return () => { owners.delete(id); window.dispatchEvent(new CustomEvent('ffn-fullscreen', { detail: isOverlayActive() })); };
  }, [active]);
}
