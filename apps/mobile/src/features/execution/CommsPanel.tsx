import { memo, useEffect, useMemo } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { EyeOff, MessageSquare } from 'lucide-react-native';
import { alpha, colors } from '@/theme';
import { formatSimClock } from '@loopkeeper/core';
import { useTick } from '@/hooks/useTick';
import { Chip, PressableScale, T } from '@/components/ui';
import { JsonBlock } from '@/components/incident/JsonBlock';
import { useComms, filterEvents, isFailure } from '@/features/comms/store';
import { acquireComms } from '@/features/comms/runtime';
import { ROLE_FILTERS, type CommunicationEventV1, type ConnState } from '@/features/comms/types';

const CONN_TONE: Record<ConnState, 'nominal' | 'watch' | 'warning' | 'critical' | 'service'> = { LIVE: 'nominal', CONNECTING: 'watch', RECONNECTING: 'watch', REPLAY: 'service', STALE: 'warning', OFFLINE: 'critical', ERROR: 'critical' };
const SHOWN = 200;

const clsColor = (c: string) => (c === 'sentinel' ? colors.sentinel : c === 'inpipe' ? colors.inpipe : c === 'outrig' ? colors.outrig : colors.t2);

const Row = memo(function Row({ e, open, onPress }: { e: CommunicationEventV1; open: boolean; onPress: () => void }) {
  const bad = isFailure(e);
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: colors.line, backgroundColor: bad ? alpha(colors.critical, 0.06) : 'transparent' }}>
      <PressableScale scaleTo={0.995} onPress={onPress} accessibilityRole="button" accessibilityState={{ expanded: open }} style={{ padding: 12, gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <T v="micro" color={clsColor(e.sender.class)} style={{ fontFamily: 'Geist_700Bold' }}>
            {e.sender.id}
          </T>
          {e.recipient ? (
            <T v="micro" color={colors.t4}>
              → {e.recipient.id}
            </T>
          ) : null}
          <T v="monoSmall" color={colors.t4} style={{ marginLeft: 'auto' }}>
            T+{formatSimClock(e.sim_time_ms / 1000)} · #{e.seq}
          </T>
        </View>
        <T v="callout" color={bad ? colors.critical : colors.t1} numberOfLines={open ? undefined : 3}>
          {e.summary}
        </T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          <Chip sm mono>
            {e.kind && /^[A-Z_]+$/.test(e.kind) ? e.kind : e.message_type}
          </Chip>
          {e.subtype ? (
            <Chip sm mono tone={bad ? 'critical' : 'neutral'}>
              {e.subtype}
            </Chip>
          ) : null}
        </View>
      </PressableScale>
      {open ? (
        <View style={{ paddingHorizontal: 12, paddingBottom: 12, gap: 8 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {([['incident', e.incident_id], ['task', e.task_id], ['robot', e.robot_id], ['asset', e.asset_id], ['thread', e.thread_id]] as const).map(([k, v]) =>
              v ? (
                <Chip key={k} sm mono>
                  {k}: {v}
                </Chip>
              ) : null,
            )}
          </View>
          {e.detail ? <JsonBlock label="Detail" value={e.detail} /> : null}
        </View>
      ) : null}
    </View>
  );
});

/**
 * Communications feed: the `comm.*` events of the target run, newest first. Hide it and a one-line bar (with the unread
 * count) takes its place; reopen restores it. Ingestion never stops while it is hidden.
 */
export function CommsPanel() {
  const { events, open, conn, mode, cursorTick, filter, query, selectedId, unread, runId, backfill, dropped, previewAt } = useComms();
  useEffect(() => acquireComms(), []);
  const now = useTick(2000);
  const list = useMemo(() => filterEvents(events, { filter, query, mode, cursorTick }), [events, filter, query, mode, cursorTick]);
  const shown = useMemo(() => list.slice(-SHOWN).reverse(), [list]);
  const st = useComms.getState();

  if (!open) {
    return (
      <PressableScale onPress={() => st.setOpen(true)} accessibilityRole="button" accessibilityLabel={`Show communications, ${unread} unread`} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.045)', borderWidth: 1, borderColor: colors.line2 }}>
        <MessageSquare size={18} color={colors.accent} />
        <T v="headline" style={{ fontSize: 15, flex: 1 }}>
          Communications hidden
        </T>
        {unread > 0 ? <Chip tone="accent">{unread} new</Chip> : <T v="caption" color={colors.t3}>no new</T>}
        <T v="callout" color={colors.accent}>
          Reopen
        </T>
      </PressableScale>
    );
  }
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Chip tone={CONN_TONE[conn]}>{conn}</Chip>
        <T v="monoSmall" color={colors.t3} numberOfLines={1} style={{ flex: 1 }}>
          {runId ?? 'no run'} · {list.length}/{events.length}
        </T>
        <PressableScale onPress={() => st.setOpen(false)} accessibilityRole="button" accessibilityLabel="Hide communications" style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 30, paddingHorizontal: 11, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: colors.line2 }}>
          <EyeOff size={14} color={colors.t2} />
          <T v="caption" color={colors.t2}>
            Hide
          </T>
        </PressableScale>
      </View>
      {mode === 'replay' ? (
        <T v="caption" color={colors.watch}>
          Replay: only messages at or before the playhead are shown.
        </T>
      ) : null}
      {previewAt > 0 && now - previewAt < 15000 ? (
        <T v="caption" color={colors.watch}>
          An operator ghost preview is running (preview only, not a command).
        </T>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {ROLE_FILTERS.map((f) => (
          <PressableScale key={f.id} scaleTo={0.95} onPress={() => st.setFilter(f.id)} accessibilityRole="button" accessibilityState={{ selected: filter === f.id }}>
            <Chip tone={filter === f.id ? 'accent' : 'neutral'}>{f.label}</Chip>
          </PressableScale>
        ))}
      </ScrollView>
      <TextInput value={query} onChangeText={st.setQuery} placeholder="Search messages, robots, incidents" placeholderTextColor={colors.t4} accessibilityLabel="Search communications" autoCapitalize="none" autoCorrect={false} style={{ height: 38, borderRadius: 11, paddingHorizontal: 12, color: colors.t1, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: colors.line, fontFamily: 'Geist_500Medium', fontSize: 13.5 }} />
      {backfill.state === 'error' ? (
        <T v="caption" color={colors.critical}>
          Could not load messages: {backfill.error}. Retrying.
        </T>
      ) : null}
      {shown.length === 0 ? (
        <View style={{ padding: 18, alignItems: 'center', gap: 4, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: colors.line }}>
          <T v="headline" style={{ fontSize: 14.5 }}>
            {events.length ? 'No message matches' : backfill.state === 'loading' ? 'Loading messages…' : 'No messages yet'}
          </T>
          <T v="caption" color={colors.t3} style={{ textAlign: 'center' }}>
            {events.length ? 'Clear the filter or search.' : 'Agent, tool, verification and safety messages appear here as the run produces them. Nothing is invented.'}
          </T>
        </View>
      ) : (
        <View style={{ borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: colors.line, overflow: 'hidden' }}>
          {shown.map((e) => (
            <Row key={`${e.run_id}:${e.seq}`} e={e} open={selectedId === e.event_id} onPress={() => st.select(selectedId === e.event_id ? null : e.event_id)} />
          ))}
        </View>
      )}
      {list.length > SHOWN ? (
        <T v="caption" color={colors.t3}>
          Showing the newest {SHOWN} of {list.length}.
        </T>
      ) : null}
      {dropped > 0 ? (
        <T v="caption" color={colors.t4}>
          {dropped} oldest messages were trimmed from memory.
        </T>
      ) : null}
    </View>
  );
}
