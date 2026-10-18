import { useEffect, useRef, useState } from 'react';
import { Platform, TextInput, View } from 'react-native';
import { Rocket, X } from 'lucide-react-native';
import { alpha, colors } from '@/theme';
import { getJson, postJson } from '@/lib/http';
import { useRuns } from '@/hooks/useRuns';
import { Button, Chip, PressableScale, T } from '@/components/ui';

const PRESETS = [
  { label: 'Middle racks overheating', prompt: 'Something is wrong with the water near the middle racks, maybe overheating. Handle it.' },
  { label: 'Back racks cooling & blocked pipe', prompt: 'The cooling near the back racks seems to be dying and one pipe is probably blocked. Fix it.' },
  { label: 'CDU pump pressure drop', prompt: 'CDU secondary pump pressure is dropping rapidly and Row A temperatures are spiking. Check it out.' },
  { label: 'Central manifold coolant leak', prompt: 'Potential chemical or coolant leak spotted near central manifold valve. Isolate immediately.' },
];

const PHASES = [
  { id: 'RECEIVED', label: 'Received' },
  { id: 'CLASSIFYING', label: 'Classifying' },
  { id: 'INTERPRETING', label: 'Interpreting' },
  { id: 'VALIDATING', label: 'Compiling a safe scenario' },
  { id: 'CREATING_RUN', label: 'Creating the run' },
  { id: 'RUNNING', label: 'Running physics and robots' },
];

interface ReqState {
  request_id: string;
  status: string;
  phase: string;
  run_id?: string | null;
  error_message?: string | null;
  interpretation?: { compiler?: { definition_of_done?: unknown[]; resolved_assets?: string[]; validation_report?: { readiness?: string } }; crusoe?: { proposal?: { summary?: string } } } | null;
}

const idem = () => `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
const DONE = new Set(['READY', 'FAILED', 'CANCELED']);

/** Natural-language scenario launcher. The backend interprets the prompt, compiles a safe scenario and starts a run; nothing here simulates it. */
export function ScenarioPanel({ onRun }: { onRun: (runId: string) => void }) {
  const [prompt, setPrompt] = useState(PRESETS[0].prompt);
  const [req, setReq] = useState<ReqState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const iv = useRef<ReturnType<typeof setInterval> | null>(null);
  const handed = useRef<string | null>(null);

  const stop = () => {
    if (iv.current) clearInterval(iv.current);
    iv.current = null;
  };
  useEffect(() => stop, []);

  const poll = (id: string) => {
    stop();
    iv.current = setInterval(async () => {
      const r = await getJson<ReqState>(`/scenario-requests/${encodeURIComponent(id)}`);
      if (r.status !== 'ok') return; // transient: keep polling
      setReq(r.json);
      if (DONE.has(r.json.status)) {
        stop();
        setBusy(false);
        if (r.json.status === 'FAILED') setError(r.json.error_message || 'The scenario pipeline failed.');
        if (r.json.status === 'READY' && r.json.run_id && handed.current !== r.json.run_id) {
          handed.current = r.json.run_id;
          void useRuns.getState().refresh();
          onRun(r.json.run_id);
        }
      }
    }, 800);
  };

  const launch = async () => {
    const text = prompt.trim();
    if (text.length < 3 || busy) return;
    setBusy(true);
    setError(null);
    setReq(null);
    handed.current = null;
    const r = await postJson<ReqState>('/scenario-requests', { prompt: text, requested_duration_seconds: 1800, requested_speed: 1 }, // browsers: the backend's CORS allow-list has no Idempotency-Key, so a web build must not send it (native has no CORS)
      Platform.OS === 'web' ? {} : { 'Idempotency-Key': idem() });
    if (r.status !== 'ok') {
      setBusy(false);
      setError(r.status === 'error' ? `${r.message}${r.httpStatus === 403 ? ' (this operator is not allowed to launch scenarios)' : ''}` : 'This backend does not accept scenario requests.');
      return;
    }
    setReq({ ...r.json, status: r.json.status ?? 'QUEUED', phase: r.json.phase ?? 'RECEIVED' });
    poll(r.json.request_id);
  };

  const cancel = async () => {
    if (!req) return;
    await postJson(`/scenario-requests/${encodeURIComponent(req.request_id)}/cancel`, {});
  };

  const idx = req ? PHASES.findIndex((p) => p.id === req.phase) : -1;
  const compiler = req?.interpretation?.compiler;
  return (
    <View style={{ gap: 12 }}>
      <T v="callout" color={colors.t2}>
        Describe what is wrong in plain language. The backend classifies it, compiles a safe scenario and starts a run; the physics, robots and agents then act on it.
      </T>
      <TextInput
        value={prompt}
        onChangeText={setPrompt}
        multiline
        maxLength={2000}
        editable={!busy}
        accessibilityLabel="Scenario prompt"
        placeholder="e.g. The cooling near the back racks seems to be dying…"
        placeholderTextColor={colors.t4}
        style={{ minHeight: 96, maxHeight: 180, textAlignVertical: 'top', padding: 12, borderRadius: 14, color: colors.t1, backgroundColor: 'rgba(0,0,0,0.3)', borderWidth: 1, borderColor: colors.line2, fontFamily: 'Geist_400Regular', fontSize: 15, lineHeight: 21 }}
      />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {PRESETS.map((p) => (
          <PressableScale key={p.label} scaleTo={0.96} disabled={busy} onPress={() => setPrompt(p.prompt)} accessibilityRole="button" accessibilityLabel={`Use prompt: ${p.label}`}>
            <Chip tone={prompt === p.prompt ? 'accent' : 'neutral'}>{p.label}</Chip>
          </PressableScale>
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button label={busy ? 'Launching…' : 'Launch scenario'} icon={Rocket} variant="primary" flex disabled={busy || prompt.trim().length < 3} haptics="medium" onPress={() => void launch()} />
        {busy && req ? <Button label="Cancel" icon={X} onPress={() => void cancel()} /> : null}
      </View>

      {req ? (
        <View style={{ gap: 8, padding: 14, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: colors.line }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Chip tone={req.status === 'READY' ? 'nominal' : req.status === 'FAILED' || req.status === 'CANCELED' ? 'critical' : 'watch'}>{req.status}</Chip>
            <T v="monoSmall" color={colors.t3} numberOfLines={1} style={{ flex: 1 }}>
              {req.request_id}
            </T>
          </View>
          {PHASES.map((p, i) => {
            const done = req.status === 'READY' ? true : i < idx;
            const cur = i === idx && req.status !== 'READY';
            return (
              <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: done ? colors.nominal : cur ? colors.accent : 'transparent', borderWidth: 2, borderColor: done ? colors.nominal : cur ? colors.accent : colors.t4 }} />
                <T v="callout" color={done || cur ? colors.t1 : colors.t3}>
                  {p.label}
                </T>
              </View>
            );
          })}
          {compiler?.validation_report?.readiness ? (
            <T v="caption" color={colors.t2}>
              Readiness: {String(compiler.validation_report.readiness)}
              {compiler.resolved_assets?.length ? ` · assets: ${compiler.resolved_assets.slice(0, 6).join(', ')}` : ''}
            </T>
          ) : null}
          {req.status === 'READY' && req.run_id ? (
            <T v="caption" color={colors.nominal}>
              Run {req.run_id} is ready. See Comms, DoD and Team for it.
            </T>
          ) : null}
        </View>
      ) : null}
      {error ? (
        <View style={{ padding: 12, borderRadius: 14, backgroundColor: alpha(colors.critical, 0.09), borderWidth: 1, borderColor: alpha(colors.critical, 0.3) }}>
          <T v="callout" color={colors.critical}>
            {error}
          </T>
        </View>
      ) : null}
    </View>
  );
}
