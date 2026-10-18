import { useEffect } from 'react';
import { useLayoutMode } from './layout';

/** Compact chrome (slim top bar + tab bar). Kept as a thin alias of the layout model so older call sites keep working. */
export function usePhoneLayout(): boolean {
  return useLayoutMode().compact;
}

/**
 * Soft keyboard / dynamic browser chrome: expose the visual viewport height as --vvh (falls back to 100dvh in CSS), flag an open keyboard
 * (`html[data-kb='1']` hides the tab bar so the field is not squeezed) and bring a focused field into view above the keyboard.
 */
export function useVisualViewportVar() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let raf = 0;
    const set = () => {
      raf = 0;
      document.documentElement.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
      const kb = window.innerHeight - vv.height - vv.offsetTop > 120 || vv.height < window.innerHeight * 0.72;
      document.documentElement.dataset.kb = kb ? '1' : '0';
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(set);
    };
    const field = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || !(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement)) return;
      if (document.documentElement.dataset.compact !== '1') return;
      // wait for the keyboard animation, then centre the field in what is left
      setTimeout(() => t.isConnected && t.scrollIntoView({ block: 'center', behavior: 'smooth' }), 320);
    };
    set();
    vv.addEventListener('resize', on);
    vv.addEventListener('scroll', on);
    document.addEventListener('focusin', field);
    return () => {
      vv.removeEventListener('resize', on);
      vv.removeEventListener('scroll', on);
      document.removeEventListener('focusin', field);
      cancelAnimationFrame(raf);
    };
  }, []);
}
