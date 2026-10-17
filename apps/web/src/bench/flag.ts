/** `?bench` in the URL turns the harness on. Kept in its own tiny module so the shell can test it without loading the bench code (three/R3F). */
export const benchEnabled = typeof location !== 'undefined' && new URLSearchParams(location.search).has('bench');
