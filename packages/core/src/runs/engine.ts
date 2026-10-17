/** Engine-side half of the runs module (pulls in the simulator). The browser app only reaches it through the embedded transport. */
export { RunRecorder, buildEngine, captureFrame, configFromOptions, frameHash, FRAME_EVERY, CHECKPOINT_EVERY, MAX_FRAMES, NON_PHYSICAL } from './recorder';
export type { RunConfig } from './recorder';
export { RunRegistry } from './registry';
export type { RegistryOptions } from './registry';
export { EmbeddedRunsApi } from './api';
