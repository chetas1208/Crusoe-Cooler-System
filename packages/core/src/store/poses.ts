import type { RobotPose, Vec3 } from '../contracts';
import { angleDelta } from '../geometry';

/**
 * Robot pose interpolation buffer.
 *
 * The backend streams poses at 2–10 Hz; the renderer runs at display refresh. We
 * render a short, fixed delay in the past and interpolate between the two server
 * samples that bracket it. We never extrapolate beyond the latest sample
 * ("predict no new path beyond latest server update" — frontend-ui.md §5), so a
 * stalled stream makes a robot stop rather than drift on invented motion.
 */

export interface PoseSample {
  t: number; // wall-clock ms at arrival
  pos: Vec3;
  yaw: number;
  speed: number;
  /** server-reported nose direction (unit vector) when available */
  dir?: Vec3;
  /** server orientation quaternion [x,y,z,w] */
  quat?: [number, number, number, number];
  seg?: string;
  s?: number;
}

export type PoseBuffers = Map<string, PoseSample[]>;
/** The live stream's buffers. Live events only ever write here. */
const liveBuffers: PoseBuffers = new Map();
/** What the renderer samples. The Execution tab points this at a separate buffer while it shows a replay/branch world. */
let buffers: PoseBuffers = liveBuffers;
const MAX = 40;

export const createPoseBuffers = (): PoseBuffers => new Map();
/** Select which buffers `samplePose` reads (null = live). Additive seam for the Execution tab. */
export function setPoseBuffers(b: PoseBuffers | null) {
  buffers = b ?? liveBuffers;
}

export const POSE_DELAY_MS = 160;

export function pushPose(robotId: string, pose: RobotPose, t = Date.now(), into: PoseBuffers = liveBuffers) {
  let b = into.get(robotId);
  if (!b) into.set(robotId, (b = []));
  const last = b[b.length - 1];
  // collapse identical timestamps (e.g. snapshot + first pose in one tick)
  if (last && t - last.t < 1) b.pop();
  b.push({ t, pos: [...pose.position_xyz_m] as Vec3, yaw: pose.yaw_rad, speed: pose.speed_m_s, dir: pose.heading_xyz ? ([...pose.heading_xyz] as Vec3) : undefined, quat: pose.quaternion_xyzw ? ([...pose.quaternion_xyzw] as [number, number, number, number]) : undefined, seg: pose.segment_id, s: pose.s_m });
  if (b.length > MAX) b.shift();
}

export function resetPoses(into: PoseBuffers = liveBuffers) {
  into.clear();
}

export interface SampledPose {
  pos: Vec3;
  yaw: number;
  speed: number;
  /** ms since the newest server sample — large values mean the stream is stale */
  age: number;
  /** nose direction (unit) from the newest bracketing sample, if the server sent one */
  dir?: Vec3;
  /** orientation [x,y,z,w], interpolated between the bracketing samples (shortest-arc nlerp), when the server sends it */
  quat?: [number, number, number, number];
  seg?: string;
  s?: number;
}

function nlerpQuat(a: [number, number, number, number] | undefined, b: [number, number, number, number] | undefined, f: number) {
  if (!a || !b) return b ?? a;
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const k = d < 0 ? -1 : 1;
  const q: [number, number, number, number] = [a[0] + (k * b[0] - a[0]) * f, a[1] + (k * b[1] - a[1]) * f, a[2] + (k * b[2] - a[2]) * f, a[3] + (k * b[3] - a[3]) * f];
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n] as [number, number, number, number];
}

export function samplePose(robotId: string, now = Date.now(), delay = POSE_DELAY_MS): SampledPose | null {
  const b = buffers.get(robotId);
  if (!b || b.length === 0) return null;
  const target = now - delay;
  const newest = b[b.length - 1];
  const age = now - newest.t;
  if (b.length === 1 || target >= newest.t) return { pos: newest.pos, yaw: newest.yaw, speed: age > 1500 ? 0 : newest.speed, age, dir: newest.dir, quat: newest.quat, seg: newest.seg, s: newest.s };
  if (target <= b[0].t) return { pos: b[0].pos, yaw: b[0].yaw, speed: b[0].speed, age, dir: b[0].dir, quat: b[0].quat, seg: b[0].seg, s: b[0].s };
  let i = b.length - 1;
  while (i > 0 && b[i - 1].t > target) i--;
  const a = b[i - 1];
  const c = b[i];
  const f = (target - a.t) / Math.max(c.t - a.t, 1);
  return {
    pos: [a.pos[0] + (c.pos[0] - a.pos[0]) * f, a.pos[1] + (c.pos[1] - a.pos[1]) * f, a.pos[2] + (c.pos[2] - a.pos[2]) * f],
    yaw: a.yaw + angleDelta(a.yaw, c.yaw) * f,
    speed: a.speed + (c.speed - a.speed) * f,
    age,
    dir: c.dir,
    quat: nlerpQuat(a.quat, c.quat, f),
    seg: c.seg,
    s: a.s !== undefined && c.s !== undefined && a.seg === c.seg ? a.s + (c.s - a.s) * f : c.s,
  };
}
