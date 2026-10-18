import { useMemo, useState, type ReactNode } from 'react';
import { Bell, Download, MoreHorizontal, Pause, Play, Plus, RefreshCw, Search, Settings, Trash2, Layers, Activity, Eye } from 'lucide-react';
import {
  Badge, Button, Dialog, Divider, Drawer, EmptyState, ErrorState, Field, IconButton, Input, KeyValue, Kbd, LoadingSkeleton, Menu, Panel, Popover, SegmentedControl, Select, Sheet, Skeleton, Slider,
  Stat, StatusDot, Switch, TabPanel, Tabs, Textarea, ToastCard, Toaster, Tooltip, toast, contrast, type ButtonSize, type ButtonVariant, type Tone,
} from '../ui/kit/index';
import { Chip } from '../ui/kit';
import './gallery.css';

const TONES: Tone[] = ['neutral', 'accent', 'info', 'nominal', 'watch', 'warning', 'critical', 'isolated', 'sentinel', 'inpipe', 'outrig'];
const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger', 'warn'];
const SIZES: ButtonSize[] = ['sm', 'md', 'lg'];

const Code = ({ children }: { children: string }) => <pre className="dg__code" aria-label="Component code">{children}</pre>;
const Block = ({ title, children }: { title: string; children: ReactNode }) => <div className="dg__block"><h3>{title}</h3>{children}</div>;
const Sec = ({ id, title, lede, children }: { id: string; title: string; lede: string; children: ReactNode }) => (
  <section className="dg__sec" id={id} data-gallery-section={id}><h2>{title}</h2><p className="dg__lede">{lede}</p>{children}</section>
);
const Cell = ({ cap, children }: { cap: string; children: ReactNode }) => <div className="dg__cell">{children}<span className="dg__cap">{cap}</span></div>;

const css = (v: string) => (typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue(v).trim());

/* ───────── tokens + contrast ───────── */
function Tokens() {
  const swatches = ['--bg', '--panel-solid', '--lk-surface-1', '--lk-surface-2', '--t1', '--t2', '--t3', '--t4', '--accent', '--nominal', '--watch', '--warning', '--critical', '--sentinel', '--inpipe', '--isolated'];
  return (
    <Sec id="tokens" title="Tokens" lede="Graphite surfaces, one teal accent, four semantic signal colours. Everything below is a CSS custom property in styles/tokens.css; components never use literals.">
      <Block title="Colour"><div className="dg__stage"><div className="dg__swatches">{swatches.map((s) => <div className="dg__sw" key={s}><i style={{ background: `var(${s})` }} /><span>{s}<br />{css(s)}</span></div>)}</div></div></Block>
      <Block title="Spacing 4 / 8 / 12 / 16 / 24 / 32"><div className="dg__stage dg__stage--col">{[1, 2, 3, 4, 5, 6].map((n) => <div className="dg__row" key={n}><span>--lk-space-{n}</span><div className="dg__bar" style={{ width: `var(--lk-space-${n})` }} /><span>{css(`--lk-space-${n}`)}</span></div>)}</div></Block>
      <Block title="Radius"><div className="dg__stage">{['xs', 'sm', 'md', 'lg', 'xl', 'pill'].map((r) => <Cell key={r} cap={`--lk-r-${r} ${css(`--lk-r-${r}`)}`}><div style={{ width: 64, height: 40, background: 'var(--lk-fill-2)', border: '1px solid var(--lk-bd-3)', borderRadius: `var(--lk-r-${r})` }} /></Cell>)}</div></Block>
      <Block title="Elevation + border opacity"><div className="dg__stage">{[0, 1, 2, 3].map((e) => <Cell key={e} cap={`--lk-elev-${e}`}><div className="dg__elev" style={{ boxShadow: `var(--lk-elev-${e})` }}>elev {e}</div></Cell>)}
        {['--lk-bd-1', '--lk-bd-2', '--lk-bd-3', '--lk-bd-ctl'].map((b) => <Cell key={b} cap={`${b} ${css(b)}`}><div className="dg__elev" style={{ border: `1px solid var(${b})`, background: 'transparent' }}>border</div></Cell>)}</div></Block>
      <Block title="Type scale (min 12px)"><div className="dg__stage dg__stage--col">{[['xs', 12], ['sm', 13], ['md', 14], ['lg', 16], ['xl', 20], ['2xl', 28]].map(([k, px]) => <div className="dg__row" key={k}><span>--lk-fs-{k}</span><span style={{ width: 'auto', fontFamily: 'var(--font)', fontSize: `var(--lk-fs-${k})`, color: 'var(--t1)' }}>Coolant loop B holds 31.4 °C ({px}px)</span></div>)}</div></Block>
      <Block title="Motion + focus ring"><div className="dg__stage">{[1, 2, 3, 4].map((m) => <Cell key={m} cap={`--lk-dur-${m} ${css(`--lk-dur-${m}`)}`}><div className="dg__bar" style={{ width: 80 }} /></Cell>)}
        <Cell cap="focus: 2px accent, offset 2px (Tab to see)"><Button variant="secondary" force="focus">Focus ring</Button></Cell></div></Block>
    </Sec>
  );
}

function ContrastTable() {
  const rows = useMemo(() => {
    const g = css('--bg') || '#090b0f';
    const pairs: Array<[string, string, string, string, number]> = [
      ['Body text', '--t1', '--panel-solid', 'text', 4.5], ['Secondary text', '--t2', '--panel-solid', 'text', 4.5], ['Tertiary text', '--t3', '--panel-solid', 'text', 4.5],
      ['Tertiary on fill', '--t3', '--lk-surface-2', 'text', 4.5], ['Accent text', '--accent', '--panel-solid', 'text', 4.5], ['Nominal', '--nominal', '--panel-solid', 'text', 4.5], ['Watch', '--watch', '--panel-solid', 'text', 4.5],
      ['Warning', '--warning', '--panel-solid', 'text', 4.5], ['Critical', '--critical', '--panel-solid', 'text', 4.5], ['Sentinel', '--sentinel', '--panel-solid', 'text', 4.5], ['Disabled (exempt)', '--t4', '--panel-solid', 'info', 3],
      ['Input boundary', '--lk-bd-ctl', '--panel-solid', 'ui', 3],
    ];
    return pairs.map(([name, fg, bg, kind, min]) => {
      const bgc = css(bg) || '#11141a';
      const r = contrast(css(fg), bgc, g);
      return { name, fg, bg, kind, min, r };
    });
  }, []);
  return (
    <Block title="Measured contrast (computed from live tokens)">
      <div className="dg__stage dg__stage--col" style={{ overflowX: 'auto' }}>
        <table className="dg__ctr"><thead><tr><th>Pair</th><th>Foreground</th><th>Background</th><th>Ratio</th><th>Needs</th><th>Result</th></tr></thead>
          <tbody>{rows.map((x) => <tr key={x.name}><td>{x.name}</td><td>{x.fg}</td><td>{x.bg}</td><td>{x.r.toFixed(2)}:1</td><td>{x.min}:1 ({x.kind})</td><td className={x.r >= x.min ? 'dg__pass' : 'dg__fail'}>{x.r >= x.min ? 'Pass' : 'Fail'}</td></tr>)}</tbody></table>
      </div>
    </Block>
  );
}

/* ───────── buttons ───────── */
function Buttons() {
  const [variant, setVariant] = useState<ButtonVariant>('primary');
  const [size, setSize] = useState<ButtonSize>('md');
  const [loading, setLoading] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [reason, setReason] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [toggle, setToggle] = useState(false);
  const code = `<Button variant="${variant}" size="${size}"${loading ? ' loading' : ''}${disabled ? ' disabled' : ''}${reason ? ' disabledReason="Select a scenario first"' : ''}${pressed ? ' pressed' : ''} icon={<Play size={14} />}>Run scenario</Button>`;
  const states: Array<[string, Partial<{ force: 'hover' | 'active' | 'focus'; disabled: boolean; loading: boolean; disabledReason: string; pressed: boolean }>]> = [
    ['default', {}], ['hover', { force: 'hover' }], ['active', { force: 'active' }], ['focus-visible', { force: 'focus' }], ['pressed', { pressed: true }], ['loading', { loading: true }], ['disabled', { disabled: true }], ['disabled + reason', { disabledReason: 'Needs an active run' }],
  ];
  return (
    <Sec id="buttons" title="Buttons" lede="Five variants, three sizes, icon-only with a required aria-label, loading, pressed toggles, and disabled-with-reason (stays focusable so the tooltip is reachable by keyboard).">
      <Block title="Playground (live props)">
        <div className="dg__stage dg__stage--col">
          <div className="dg__controls">
            <Field label="variant"><Select value={variant} onChange={(e) => setVariant(e.target.value as ButtonVariant)}>{VARIANTS.map((v) => <option key={v}>{v}</option>)}</Select></Field>
            <Field label="size"><SegmentedControl label="size" size="sm" value={size} onChange={setSize} items={SIZES.map((s) => ({ id: s, label: s }))} /></Field>
            <Switch label="loading" checked={loading} onChange={setLoading} /><Switch label="disabled" checked={disabled} onChange={setDisabled} />
            <Switch label="reason" checked={reason} onChange={setReason} /><Switch label="pressed" checked={pressed} onChange={setPressed} />
          </div>
          <div><Button variant={variant} size={size} loading={loading} disabled={disabled} disabledReason={reason ? 'Select a scenario first' : undefined} pressed={pressed || undefined} icon={<Play size={14} />}>Run scenario</Button></div>
          <Code>{code}</Code>
        </div>
      </Block>
      <Block title="Variant by state (sizes md)">
        <div className="dg__stage dg__stage--col"><div className="dg__matrix" style={{ gridTemplateColumns: `90px repeat(${states.length}, max-content)` }}>
          <span className="dg__cap" />{states.map(([n]) => <span className="dg__cap" key={n}>{n}</span>)}
          {VARIANTS.map((v) => [<span className="dg__cap" key={v}>{v}</span>, ...states.map(([n, p]) => <Button key={v + n} variant={v} {...p}>Label</Button>)])}
        </div></div>
      </Block>
      <Block title="Sizes (28 / 32 / 40 px; 44 px hit area on coarse pointers)">
        <div className="dg__stage">{SIZES.map((s) => <Cell key={s} cap={s}><Button size={s} variant="primary" icon={<Plus size={14} />}>New run</Button></Cell>)}
          {SIZES.map((s) => <Cell key={'i' + s} cap={`icon ${s}`}><IconButton size={s} variant="secondary" aria-label={`Add ${s}`} icon={<Plus size={16} />} /></Cell>)}</div>
      </Block>
      <Block title="Icon-only (aria-label required, tooltip from label)">
        <div className="dg__stage">
          <IconButton aria-label="Settings" icon={<Settings size={16} />} /><IconButton aria-label="Refresh" icon={<RefreshCw size={16} />} variant="secondary" />
          <IconButton aria-label="Pause simulation" pressed={toggle} onClick={() => setToggle(!toggle)} icon={toggle ? <Play size={16} /> : <Pause size={16} />} variant="secondary" />
          <IconButton aria-label="Delete run" icon={<Trash2 size={16} />} variant="danger" /><IconButton aria-label="Refresh" icon={<RefreshCw size={16} />} loading />
          <IconButton aria-label="Export" icon={<Download size={16} />} disabledReason="Nothing to export yet" />
        </div>
        <Code>{`<IconButton aria-label="Refresh" icon={<RefreshCw size={16} />} variant="secondary" />`}</Code>
      </Block>
      <Block title="Legacy classes, same look (.btn .btn--primary .btn--sm .icon-btn)">
        <div className="dg__stage"><button className="btn">Default</button><button className="btn btn--primary">Primary</button><button className="btn btn--ghost">Ghost</button><button className="btn btn--danger">Danger</button><button className="btn btn--sm">Small</button><button className="btn" disabled>Disabled</button><button className="icon-btn" aria-label="Notifications"><Bell size={16} /></button><button className="icon-btn" aria-pressed="true" aria-label="Layers"><Layers size={16} /></button></div>
      </Block>
    </Sec>
  );
}

/* ───────── selection ───────── */
function Selection() {
  const [seg, setSeg] = useState('map');
  const [tab, setTab] = useState('overview');
  return (
    <Sec id="selection" title="Segmented control and tabs" lede="Segmented = pick one value in place (radiogroup). Tabs = switch the content below (tablist + tabpanel). Both use roving tabindex: Tab enters once, arrows move, Home/End jump.">
      <div className="dg__twocol">
        <Block title="SegmentedControl"><div className="dg__stage dg__stage--col">
          <SegmentedControl label="View" value={seg} onChange={setSeg} items={[{ id: 'map', label: 'Map', icon: <Layers size={14} /> }, { id: 'agents', label: 'Agents', icon: <Activity size={14} /> }, { id: 'exec', label: 'Execution' }, { id: 'off', label: 'Replay', disabled: true, disabledReason: 'Replay needs a finished run' }]} />
          <SegmentedControl label="Density" size="sm" value={seg === 'map' ? 'a' : 'b'} onChange={() => undefined} items={[{ id: 'a', label: 'Compact' }, { id: 'b', label: 'Comfortable' }]} />
          <SegmentedControl label="Hover state" value="agents" onChange={() => undefined} force={{ exec: 'hover' }} items={[{ id: 'map', label: 'Map' }, { id: 'agents', label: 'Agents' }, { id: 'exec', label: 'Hover' }]} />
          <Code>{`<SegmentedControl label="View" value={v} onChange={setV}\n  items={[{ id:'map', label:'Map' }, { id:'agents', label:'Agents' }]} />`}</Code>
        </div></Block>
        <Block title="Tabs"><div className="dg__stage dg__stage--col">
          <Tabs idBase="g" label="Run detail" value={tab} onChange={setTab} items={[{ id: 'overview', label: 'Overview' }, { id: 'trace', label: 'Agent trace', count: 12 }, { id: 'cmds', label: 'Commands', count: 3 }, { id: 'x', label: 'Disabled', disabled: true }]} />
          <TabPanel idBase="g" id="overview" value={tab}>Run overview: scenario, duration, outcome.</TabPanel>
          <TabPanel idBase="g" id="trace" value={tab}>12 agent steps recorded.</TabPanel>
          <TabPanel idBase="g" id="cmds" value={tab}>3 commands committed.</TabPanel>
          <Code>{`<Tabs idBase="run" label="Run detail" value={t} onChange={setT} items={[…]} />\n<TabPanel idBase="run" id="trace" value={t}>…</TabPanel>`}</Code>
        </div></Block>
      </div>
    </Sec>
  );
}

/* ───────── badges ───────── */
function Badges() {
  const [tone, setTone] = useState<Tone>('warning');
  return (
    <Sec id="badges" title="Badges and status" lede="Tone + icon + text, always. A colour-blind operator can read every badge by its glyph and word; status dots change shape with severity and always carry a label.">
      <Block title="Badge tones (soft / solid / outline)">
        <div className="dg__stage dg__stage--col">
          {(['soft', 'solid', 'outline'] as const).map((v) => <div key={v} className="dg__stage" style={{ border: 0, padding: 0, background: 'none' }}>{TONES.map((t) => <Badge key={t} tone={t} variant={v}>{t}</Badge>)}</div>)}
          <div className="dg__stage" style={{ border: 0, padding: 0, background: 'none' }}>{TONES.slice(0, 7).map((t) => <Badge key={t} tone={t} sm>{t}</Badge>)}<Badge tone="critical" icon={null}>No icon (opt-out)</Badge></div>
        </div>
      </Block>
      <div className="dg__twocol">
        <Block title="Playground"><div className="dg__stage dg__stage--col">
          <Field label="tone"><Select value={tone} onChange={(e) => setTone(e.target.value as Tone)}>{TONES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
          <div><Badge tone={tone}>Pump P2 degraded</Badge></div><Code>{`<Badge tone="${tone}">Pump P2 degraded</Badge>`}</Code></div></Block>
        <Block title="StatusDot (circle, diamond, triangle, square, ring)"><div className="dg__stage dg__stage--col">
          <StatusDot tone="nominal" label="Nominal" /><StatusDot tone="watch" label="Watch" /><StatusDot tone="warning" label="Warning" pulse /><StatusDot tone="critical" label="Critical" pulse /><StatusDot tone="isolated" label="Isolated" /><StatusDot tone="info" label="Streaming" />
          <Code>{`<StatusDot tone="critical" label="Critical" pulse />`}</Code></div></Block>
      </div>
      <Block title="Legacy .chip (same tokens)"><div className="dg__stage"><Chip tone="nominal">nominal</Chip><Chip tone="watch">watch</Chip><Chip tone="critical" icon={<Eye size={12} />}>critical + icon</Chip><Chip tone="accent" sm>small</Chip><Chip>neutral</Chip></div></Block>
    </Sec>
  );
}

/* ───────── panels ───────── */
function Panels() {
  const [d, setD] = useState(true);
  const [s, setS] = useState(true);
  return (
    <Sec id="panels" title="Panels, cards, drawers, sheets" lede="One chrome: header (title, actions, close), body, optional footer. Collapse animates and removes hidden content from tab order. Every panel carries data-panel for overlap checks.">
      <div className="dg__twocol">
        <Panel panelId="demo-glass" title="Hall health" subtitle="live" icon={<Activity size={16} />} actions={<IconButton size="sm" aria-label="Panel settings" icon={<Settings size={16} />} />} onClose={() => undefined}>
          <KeyValue items={[{ k: 'Racks online', v: '412 / 416' }, { k: 'Loop B supply', v: '31.4 °C', tone: 'watch' }, { k: 'Active incidents', v: '1', tone: 'critical' }]} />
        </Panel>
        <Panel panelId="demo-solid" surface="solid" title="Incident INC-0042" footer={<><Button size="sm" variant="ghost">Dismiss</Button><Button size="sm" variant="primary">Acknowledge</Button></>}>
          <Stat label="Leak rate" value="2.4" unit="L/min" trend={{ dir: 'up', text: '+0.6 in 5 min', bad: true }} state={{ tone: 'critical', text: 'Over limit' }} />
        </Panel>
        <Panel panelId="demo-collapse" collapsible title="Collapsible panel" subtitle="click header">
          <p style={{ margin: 0, color: 'var(--t2)', lineHeight: 1.45 }}>Body content collapses with a height transition; contents leave the tab order while closed.</p>
        </Panel>
        <Panel panelId="demo-collapsed" collapsible defaultCollapsed title="Collapsed by default"><p style={{ margin: 0 }}>Hidden.</p></Panel>
        <Panel surface="card" title="Card (flat, nests in a panel)" actions={<Badge tone="nominal" sm>healthy</Badge>}><div style={{ color: 'var(--t2)', fontSize: 13 }}>Use for list items and grouped fields.</div></Panel>
        <Panel surface="card" flush title="Flush body (lists)"><div style={{ padding: 12, borderTop: '1px solid var(--lk-bd-1)' }}>Row one</div><div style={{ padding: 12, borderTop: '1px solid var(--lk-bd-1)' }}>Row two</div></Panel>
      </div>
      <Code>{`<Panel panelId="hall-health" title="Hall health" actions={…} onClose={close} collapsible footer={…}>…</Panel>`}</Code>
      <div className="dg__twocol" style={{ marginTop: 16 }}>
        <Block title="Drawer (inline preview; fixed edge in the app)"><div className="dg__fixed"><div style={{ position: 'absolute', inset: 8, display: 'flex', justifyContent: 'flex-end' }}>
          {d ? <Drawer inline open onClose={() => setD(false)} panelId="demo-drawer" title="Asset CDU-03" width={300}><KeyValue items={[{ k: 'State', v: 'Degraded', tone: 'warning' }, { k: 'Flow', v: '118 L/min' }]} /></Drawer> : <Button onClick={() => setD(true)}>Reopen drawer</Button>}</div></div></Block>
        <Block title="Sheet (inline preview; bottom on mobile)"><div className="dg__fixed"><div style={{ position: 'absolute', inset: 8, display: 'flex', alignItems: 'flex-end' }}>
          {s ? <div style={{ width: '100%' }}><Sheet inline open onClose={() => setS(false)} panelId="demo-sheet" title="Route options" height="260px"><p style={{ margin: 0, color: 'var(--t2)' }}>Pick a destination on the map.</p></Sheet></div> : <Button onClick={() => setS(true)}>Reopen sheet</Button>}</div></div></Block>
      </div>
    </Sec>
  );
}

/* ───────── overlays ───────── */
function Overlays() {
  const [dlg, setDlg] = useState<null | 'info' | 'danger'>(null);
  return (
    <Sec id="overlays" title="Tooltip, popover, menu, dialog, toast" lede="Overlays portal to body above the canvas. Esc closes, focus returns to the trigger; dialogs trap focus. Tooltips never carry essential information: they repeat a visible or aria label.">
      <div className="dg__stage">
        <Tooltip content="Re-run the last scenario"><Button variant="secondary" icon={<RefreshCw size={14} />}>Hover or focus me</Button></Tooltip>
        <Popover label="Filters" trigger={(p) => <Button variant="secondary" {...p} iconRight={<Search size={14} />}>Popover</Button>}>
          {(close) => <div style={{ display: 'grid', gap: 12 }}><Field label="Severity"><Select defaultValue="all"><option value="all">All</option><option>Critical</option></Select></Field><Switch label="Only mine" checked onChange={() => undefined} /><Button size="sm" variant="primary" onClick={close}>Apply</Button></div>}
        </Popover>
        <Menu label="Run actions" trigger={(p) => <IconButton variant="secondary" aria-label="More actions" icon={<MoreHorizontal size={16} />} tip={false} {...p} />} items={[{ id: 'a', label: 'Fork run', icon: <Layers size={14} />, hint: 'F' }, { id: 'b', label: 'Export trace', icon: <Download size={14} /> }, { id: 'c', label: 'Delete (needs admin)', icon: <Trash2 size={14} />, danger: true, disabled: true, disabledReason: 'Admin only' }]} />
        <Button variant="secondary" onClick={() => setDlg('info')}>Open dialog</Button>
        <Button variant="danger" onClick={() => setDlg('danger')}>Confirm destructive</Button>
        <Button variant="secondary" onClick={() => toast({ tone: 'nominal', title: 'Scenario launched', body: 'Run r-0192 is live.' })}>Toast: success</Button>
        <Button variant="secondary" onClick={() => toast({ tone: 'critical', title: 'Command rejected', body: 'Valve V-14 interlock is closed.', action: { label: 'View interlock', onClick: () => undefined } })}>Toast: error</Button>
      </div>
      <Code>{`<Tooltip content="Re-run"><Button>…</Button></Tooltip>\n<Menu label="Run actions" trigger={(p) => <IconButton aria-label="More" {...p} />} items={[…]} />\n<Dialog open title="Delete run?" tone="critical" onClose={…} footer={…} />\ntoast({ tone:'nominal', title:'Scenario launched' })`}</Code>
      <Block title="Toast cards (static)"><div className="dg__stage dg__stage--grid">
        <ToastCard t={{ tone: 'nominal', title: 'Scenario launched', body: 'Run r-0192 is live.' }} onClose={() => undefined} />
        <ToastCard t={{ tone: 'warning', title: 'Telemetry lagging', body: 'Last frame 4.2 s ago.' }} onClose={() => undefined} />
        <ToastCard t={{ tone: 'critical', title: 'Command rejected', body: 'Valve V-14 interlock is closed.', action: { label: 'View interlock', onClick: () => undefined } }} onClose={() => undefined} />
        <ToastCard t={{ tone: 'info', title: 'Replay available' }} onClose={() => undefined} />
      </div></Block>
      <Dialog open={dlg === 'info'} onClose={() => setDlg(null)} title="Fork this run?" description="The fork copies the plant state at the selected tick. The original run is not changed." footer={<><Button variant="ghost" onClick={() => setDlg(null)}>Cancel</Button><Button variant="primary" data-autofocus onClick={() => setDlg(null)}>Fork run</Button></>} panelId="dlg-info">
        <Field label="Fork name" hint="Shown in the run list."><Input defaultValue="r-0192 fork" /></Field>
      </Dialog>
      <Dialog open={dlg === 'danger'} onClose={() => setDlg(null)} tone="critical" size="sm" title="Close valve V-14?" description="Downstream rack row 7 loses coolant flow within 40 s." footer={<><Button variant="ghost" data-autofocus onClick={() => setDlg(null)}>Keep open</Button><Button variant="danger" onClick={() => setDlg(null)}>Close valve</Button></>} panelId="dlg-danger" />
      <Toaster />
    </Sec>
  );
}

/* ───────── fields ───────── */
function Fields() {
  const [v, setV] = useState(40);
  const [on, setOn] = useState(true);
  return (
    <Sec id="fields" title="Fields" lede="Field wires label, hint and error to the control (id, aria-describedby, aria-invalid). Input borders meet 3:1 so the control is findable without relying on fill.">
      <div className="dg__twocol">
        <div className="dg__stage dg__stage--col">
          <Field label="Default" hint="Hint text sits below."><Input placeholder="Scenario name" /></Field>
          <Field label="Hover (forced)"><Input force="hover" defaultValue="Hovered" /></Field>
          <Field label="Focus (forced)"><Input force="focus" defaultValue="Focused" /></Field>
          <Field label="With icon"><Input leading={<Search size={14} />} placeholder="Search assets" /></Field>
          <Field label="Error" error="Enter a flow between 0 and 400 L/min." required><Input defaultValue="-4" /></Field>
          <Field label="Disabled"><Input disabled defaultValue="Locked while a run is live" /></Field>
        </div>
        <div className="dg__stage dg__stage--col">
          <Field label="Select"><Select defaultValue="b"><option value="a">CDU-01</option><option value="b">CDU-02</option></Select></Field>
          <Field label="Select, disabled"><Select disabled><option>CDU-01</option></Select></Field>
          <Field label="Notes" hint="Optional."><Textarea placeholder="What changed?" /></Field>
          <Field label="Pump speed"><Slider value={v} onChange={setV} unit="%" /></Field>
          <Field label="Slider, disabled"><Slider value={30} onChange={() => undefined} unit="%" disabled /></Field>
          <div style={{ display: 'grid', gap: 4 }}>
            <Switch label="Auto-commit actions" checked={on} onChange={setOn} /><Switch label="Hover (forced)" checked={false} onChange={() => undefined} force="hover" /><Switch label="Focus (forced)" checked onChange={() => undefined} force="focus" />
            <Switch label="Operator override" checked={false} onChange={() => undefined} disabledReason="Requires the admin role" />
          </div>
        </div>
      </div>
      <Code>{`<Field label="Flow" error="Enter 0-400 L/min." required><Input defaultValue="-4" /></Field>\n<Field label="Pump speed"><Slider value={v} onChange={setV} unit="%" /></Field>\n<Switch label="Auto-commit" checked={on} onChange={setOn} />`}</Code>
    </Sec>
  );
}

function States() {
  return (
    <Sec id="states" title="Empty, error, loading" lede="An empty panel invites an action. An error says what failed and how to recover, never apologises. Loading is a labelled skeleton, not a spinner over blank space.">
      <div className="dg__twocol">
        <Panel surface="card" title="EmptyState"><EmptyState title="No incidents in this run" action={<Button size="sm" variant="primary" icon={<Plus size={14} />}>Inject a fault</Button>}>Faults you inject from the scenario library appear here.</EmptyState></Panel>
        <Panel surface="card" title="ErrorState"><ErrorState title="Telemetry stream dropped" detail="ws://api/v1/stream closed (1006)" onRetry={() => undefined}>The map is showing the last frame. Reconnect to resume live data.</ErrorState></Panel>
        <Panel surface="card" title="LoadingSkeleton"><div style={{ display: 'grid', gap: 16 }}><LoadingSkeleton lines={3} avatar label="Loading run summary" /><Skeleton h={64} r={10} /></div></Panel>
        <Panel surface="card" title="Compact variants"><EmptyState compact title="Nothing selected">Click an asset on the map.</EmptyState><Divider /><ErrorState compact title="Could not load trace" onRetry={() => undefined} /></Panel>
      </div>
    </Sec>
  );
}

function Data() {
  return (
    <Sec id="data" title="Data display" lede="Stat shows a value with unit, a trend (arrow plus text) and a state (icon plus text). KeyValue is a definition list with tabular numerals.">
      <div className="dg__twocol">
        <div className="dg__stage dg__stage--grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
          <Stat label="Supply temp" value="31.4" unit="°C" trend={{ dir: 'up', text: '+1.2 / 5 min', bad: true }} state={{ tone: 'watch', text: 'Watch' }} />
          <Stat label="Flow" value="118" unit="L/min" trend={{ dir: 'down', text: '-4 / 5 min' }} state={{ tone: 'nominal', text: 'Nominal' }} />
          <Stat label="Pressure" value="2.1" unit="bar" trend={{ dir: 'flat', text: 'steady' }} />
          <Stat label="Leak rate" value="2.4" unit="L/min" tone="critical" state={{ tone: 'critical', text: 'Over limit' }} size="lg" />
        </div>
        <div className="dg__stage dg__stage--col">
          <KeyValue items={[{ k: 'Run', v: 'r-0192', mono: true }, { k: 'Scenario', v: 'CR-02 manifold leak' }, { k: 'Elapsed', v: '04:12' }, { k: 'Outcome', v: 'Contained', tone: 'nominal' }]} />
          <Divider label="dense" />
          <KeyValue dense items={[{ k: 'Valve V-14', v: 'Closed' }, { k: 'Pump P2', v: '62 %', tone: 'warning' }]} />
          <Divider />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--t2)' }}>Command palette <Kbd>Ctrl</Kbd><Kbd>K</Kbd><Divider vertical /> Close <Kbd>Esc</Kbd></div>
        </div>
      </div>
    </Sec>
  );
}

const NAV = [['tokens', 'Tokens'], ['buttons', 'Buttons'], ['selection', 'Segmented and tabs'], ['badges', 'Badges and status'], ['panels', 'Panels and sheets'], ['overlays', 'Overlays'], ['fields', 'Fields'], ['states', 'Empty, error, loading'], ['data', 'Data display'], ['contrast', 'Contrast']] as const;

export default function Gallery() {
  return (
    <div className="dg" data-design-gallery>
      <div className="dg__wrap">
        <nav className="dg__nav" aria-label="Gallery sections">
          <div className="dg__brand">Cruso Cooler System kit</div>
          <p>Dark theme only. Every component, every state. Add ?design=1 to any URL.</p>
          {NAV.map(([id, l]) => <a key={id} href={`#${id}`}>{l}</a>)}
        </nav>
        <main className="dg__main">
          <Tokens /><Buttons /><Selection /><Badges /><Panels /><Overlays /><Fields /><States /><Data />
          <Sec id="contrast" title="Contrast" lede="WCAG 2.x ratios on the graphite theme, computed in the browser from the live custom properties."><ContrastTable /></Sec>
        </main>
      </div>
    </div>
  );
}
