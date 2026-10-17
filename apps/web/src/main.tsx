import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles/tokens.css';
import './styles/base.css';
import './styles/kit.css';
import './styles/topbar.css';
import './styles/layout.css';
import './styles/incident.css';
import './styles/inspector.css';
import './styles/ribbon.css';
import './styles/callouts.css';
import './styles/pipehud.css';
import './styles/board.css';
import './styles/mobile.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';

import { useWorld } from '@loopkeeper/core/store';
import { useView, useMapCamera } from '@loopkeeper/scene';
import { useUi } from './ui/store';
import { benchEnabled } from './bench/flag';

// store handles for the benchmark / perf-audit drivers (dev builds, or any build opened with ?bench)
if (import.meta.env.DEV || benchEnabled) (window as unknown as { __lkApp: unknown }).__lkApp = { useWorld, useView, useMapCamera, useUi };

const mount = () => createRoot(document.getElementById('root')!).render(<App />);
// the perf harness (three / R3F probes) only loads with ?bench; the harness must be installed before the app starts so it sees the first frames
if (benchEnabled) import('./bench').then((b) => { b.installBench(); mount(); });
else mount();
