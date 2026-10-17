import { useEffect, useState } from 'react';

/** Phone / small-landscape layout switch. Desktop (>=861 px wide and >=481 px tall) never matches, so its layout is untouched. */
export const PHONE_QUERY = '(max-width: 860px), (max-height: 480px)';

export function usePhoneLayout(): boolean {
  const [on, setOn] = useState(() => (typeof matchMedia === 'function' ? matchMedia(PHONE_QUERY).matches : false));
  useEffect(() => {
    const mq = matchMedia(PHONE_QUERY);
    const apply = () => {
      setOn(mq.matches);
      document.documentElement.dataset.phone = mq.matches ? '1' : '0';
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return on;
}

/** Soft keyboard / dynamic browser chrome: expose the visual viewport height as --vvh (falls back to 100dvh in CSS). */
export function useVisualViewportVar() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let raf = 0;
    const set = () => {
      raf = 0;
      document.documentElement.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(set);
    };
    set();
    vv.addEventListener('resize', on);
    vv.addEventListener('scroll', on);
    return () => {
      vv.removeEventListener('resize', on);
      vv.removeEventListener('scroll', on);
      cancelAnimationFrame(raf);
    };
  }, []);
}
