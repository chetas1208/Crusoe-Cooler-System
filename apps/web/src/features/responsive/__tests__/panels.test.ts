import { beforeEach, describe, expect, it } from 'vitest';
import { closePanel, openPanel, openState, resolveActive, togglePanel, usePanelFocus, useScorecardOpen } from '../panels';
import { useCommunications } from '../../communications/communicationStore';
import { useDod } from '../../dod/store';

beforeEach(() => {
  useCommunications.setState({ open: false });
  useDod.setState({ showDod: false, showTeam: false });
  useScorecardOpen.setState({ on: false });
  usePanelFocus.setState({ focus: null });
});

describe('panel registry', () => {
  it('shows one panel at a time: opening one closes the others', () => {
    openPanel('comms');
    expect(openState()).toEqual({ comms: true, dod: false, team: false, scorecard: false });
    openPanel('dod');
    expect(openState()).toEqual({ comms: false, dod: true, team: false, scorecard: false });
    openPanel('scorecard');
    expect(openState()).toEqual({ comms: false, dod: false, team: false, scorecard: true });
  });
  it('a store flag set directly (evidence link, persisted flag) also wins over the open panel', () => {
    openPanel('dod');
    useCommunications.setState({ open: true });
    expect(openState()).toEqual({ comms: true, dod: false, team: false, scorecard: false });
    expect(usePanelFocus.getState().focus).toBe('comms');
  });
  it('toggle closes; closing the focused panel leaves the host empty', () => {
    togglePanel('team');
    expect(openState().team).toBe(true);
    togglePanel('team');
    expect(Object.values(openState()).some(Boolean)).toBe(false);
    openPanel('comms');
    closePanel('comms');
    expect(usePanelFocus.getState().focus).toBeNull();
  });
  it('closing a panel never clears Communications events or filters', () => {
    useCommunications.setState({ filter: 'tools', query: 'ir-' });
    openPanel('comms');
    closePanel('comms');
    expect(useCommunications.getState().filter).toBe('tools');
    expect(useCommunications.getState().query).toBe('ir-');
  });
  it('resolveActive prefers the focused open panel', () => {
    expect(resolveActive({ comms: true, dod: true, team: false, scorecard: false }, 'dod')).toBe('dod');
    expect(resolveActive({ comms: true, dod: false, team: false, scorecard: false }, 'dod')).toBe('comms');
    expect(resolveActive({ comms: false, dod: false, team: false, scorecard: false }, null)).toBeNull();
  });
});
