import type { ControlApi } from './client';

/** The active transport's control endpoint, set by the world store when it starts. No imports from the store (avoids a cycle). */
let api: ControlApi | null = null;
export const setControlApi = (a: ControlApi | null | undefined) => {
  api = a ?? null;
};
export const getControlApi = () => api;
