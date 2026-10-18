import { makeHideStore } from '../agents/hide';

/** Hide / reopen for the Dashboard's three overlays. Hiding unmounts the view only; polling and selection live in stores. */
export const useDashHide = makeHideStore('lk.v12.dash.hide', ['health', 'dock', 'scene'] as const);
export type DashPanel = 'health' | 'dock' | 'scene';
