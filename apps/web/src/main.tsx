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
import './styles/host.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';

import { useWorld } from '@loopkeeper/core/store';
import { useView, useMapCamera } from '@loopkeeper/scene';
import { useUi } from './ui/store';
import { benchEnabled } from './bench/flag';

// store handles for the benchmark / perf-audit / layout-matrix drivers (dev builds, or any build opened with ?bench or ?e2e)
if (import.meta.env.DEV || benchEnabled || new URLSearchParams(location.search).has('e2e')) (window as unknown as { __lkApp: unknown }).__lkApp = { useWorld, useView, useMapCamera, useUi };

// hidden design-system gallery: ?design=1 (dark theme, every kit component in every state)
const designGallery = new URLSearchParams(location.search).has('design');
const mount = () => createRoot(document.getElementById('root')!).render(<App />);
// the perf harness (three / R3F probes) only loads with ?bench; the harness must be installed before the app starts so it sees the first frames
if (designGallery) import('./design/Gallery').then((g) => createRoot(document.getElementById('root')!).render(<g.default />));
else if (benchEnabled) import('./bench').then((b) => { b.installBench(); mount(); });
else mount();
