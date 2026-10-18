import { useEffect } from 'react';
import { ScrollView, View } from 'react-native';
import { ShieldCheck } from 'lucide-react-native';
import { alpha, colors } from '@/theme';
import { Chip, Meter, PressableScale, T } from '@/components/ui';
import { useDod } from '@/features/dod/store';
import { fmtS, fmtVal, whyNotDone } from '@/features/dod/schemas';
import { TERMINALS, type CheckState, type DodCheck } from '@/features/dod/types';
import { useTargetRunId } from '@/hooks/useRuns';

/** Keeps the Definition-of-Done / Team data fresh for the target run while either panel is mounted. */
export function useDodPolling() {
  const runId = useTargetRunId();
  useEffect(() => {
    if (!runId) return;
    void useDod.getState().refresh(runId);
    const id = setInterval(() => void useDod.getState().refresh(runId), 3000);
    return () => clearInterval(id);
  }, [runId]);
  return runId;
}

const CHECK_TONE: Record<CheckState, string> = { PASS: colors.nominal, FAIL: colors.critical, UNKNOWN: colors.t3 };

function Check({ c }: { c: DodCheck }) {
  const col = CHECK_TONE[c.state];
  const holding = c.hold_required_s !== undefined && c.hold_required_s > 0;
  return (
    <View style={{ gap: 6, padding: 12, borderBottomWidth: 1, borderBottomColor: colors.line }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T v="callout" style={{ flex: 1 }} numberOfLines={2}>
          {c.label}
        </T>
        <Chip sm tone={c.state === 'PASS' ? 'nominal' : c.state === 'FAIL' ? 'critical' : 'neutral'}>
          {c.state}
        </Chip>
      </View>
      <View style={{ flexDirection: 'row', gap: 14 }}>
        <View style={{ flex: 1, gap: 1 }}>
          <T v="eyebrow" style={{ fontSize: 9 }}>
            Measured
          </T>
          <T v="mono" color={col}>
            {fmtVal(c.measured, c.unit)}
          </T>
        </View>
        <View style={{ flex: 1, gap: 1 }}>
          <T v="eyebrow" style={{ fontSize: 9 }}>
            Required
          </T>
          <T v="mono">{c.threshold === undefined ? '—' : `${c.comparator ?? ''} ${c.threshold}${c.unit ? ' ' + c.unit : ''}`}</T>
        </View>
      </View>
      {holding ? (
        <View style={{ gap: 3 }}>
          <Meter value={Math.min(1, (c.hold_elapsed_s ?? 0) / (c.hold_required_s as number))} tone={c.state === 'FAIL' ? 'critical' : 'nominal'} />
          <T v="micro" color={colors.t3}>
            held {fmtS(c.hold_elapsed_s ?? 0)} of {fmtS(c.hold_required_s as number)}
          </T>
        </View>
      ) : null}
    </View>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <View style={{ padding: 18, alignItems: 'center', gap: 4, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: colors.line }}>
      <T v="headline" style={{ fontSize: 14.5 }}>
        {title}
      </T>
      <T v="caption" color={colors.t3} style={{ textAlign: 'center' }}>
        {body}
      </T>
    </View>
  );
}

/** Definition of Done: the frozen contract's checks, measured values, holds and the terminal state. Never green without a measurement. */
export function DodPanel() {
  const runId = useDodPolling();
  const { contract, contractLoad, contractError, incidents, incidentId, updatedAt } = useDod();
  const why = whyNotDone(contract);
  if (!runId) return <Empty title="No run" body="There is no live run to read a contract from." />;
  if (contractLoad === 'error') return <Empty title="Could not load the contract" body={`${contractError ?? 'The backend returned an error'}. Retrying.`} />;
  if (contractLoad === 'unavailable' || (!contract && contractLoad !== 'loading' && contractLoad !== 'idle')) return <Empty title="No Definition of Done yet" body="A contract is published when SENTINEL opens an incident (or a scenario is compiled). None exists for this run." />;
  if (!contract) return <Empty title="Loading…" body="Reading the contract." />;
  return (
    <View style={{ gap: 12 }}>
      {incidents.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {incidents.map((i) => (
            <PressableScale key={i.incident_id} scaleTo={0.95} onPress={() => useDod.getState().pickIncident(i.incident_id)} accessibilityRole="button" accessibilityState={{ selected: i.incident_id === incidentId }}>
              <Chip tone={i.incident_id === incidentId ? 'accent' : 'neutral'} mono>
                {i.incident_id}
              </Chip>
            </PressableScale>
          ))}
        </ScrollView>
      ) : null}
      <View style={{ gap: 8, padding: 14, borderRadius: 16, backgroundColor: alpha(why.done ? colors.nominal : colors.watch, 0.08), borderWidth: 1, borderColor: alpha(why.done ? colors.nominal : colors.watch, 0.3) }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <ShieldCheck size={16} color={why.done ? colors.nominal : colors.watch} />
          <T v="eyebrow" color={why.done ? colors.nominal : colors.watch}>
            {why.done ? 'Done' : 'Not done yet'}
          </T>
          <Chip sm mono>
            {contract.contract_id} · r{contract.revision}
          </Chip>
          <Chip sm tone="neutral">
            {String(contract.lifecycle)}
          </Chip>
          {contract.terminal ? (
            <Chip sm tone={contract.terminal === 'VERIFIED' ? 'nominal' : contract.terminal === 'UNKNOWN' ? 'neutral' : 'warning'}>
              {contract.terminal.replace(/_/g, ' ')}
            </Chip>
          ) : null}
        </View>
        <T v="callout">{why.text}</T>
        {contract.revision_reason ? (
          <T v="caption" color={colors.t3}>
            Last revision: {contract.revision_reason}
          </T>
        ) : null}
      </View>
      {contract.checks.length === 0 ? (
        <Empty title="No checks" body="The contract has no checks, so nothing can be verified." />
      ) : (
        <View style={{ borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: colors.line, overflow: 'hidden' }}>
          {contract.checks.map((c) => (
            <Check key={c.id} c={c} />
          ))}
        </View>
      )}
      <T v="micro" color={colors.t4}>
        Terminal states: {TERMINALS.map((t) => t.replace(/_/g, ' ').toLowerCase()).join(' · ')}
        {updatedAt ? ` · refreshed ${new Date(updatedAt).toLocaleTimeString()}` : ''}
      </T>
    </View>
  );
}
