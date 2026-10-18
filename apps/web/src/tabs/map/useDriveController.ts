import { useEffect } from 'react';
import { controlActions, useControl } from '@loopkeeper/core/control';
import { useMapCamera, type MountedDirection } from '@loopkeeper/scene';
import { useWorld, usePreviewDrive } from '@loopkeeper/core/store';

const DIR_SLOTS: MountedDirection[] = ['front', 'rear', 'left', 'right', 'top'];

/**
 * Game-style drive & camera input controller for the Map tab.
 * Listens for W/A/S/D/Space driving controls, camera slot switching (1-5),
 * tool activations (L=lamp, E=tool/scan), and camera mode cycling (C).
 * Enforces automatic safe-stop on window blur or tab invisibility.
 * In Preview Drive (Ghost) mode, arrow keys control the local ghost proxy
 * with ZERO network calls, zero lease acquisition, and zero simulation mutation.
 */
export function useDriveController(enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    const pressed = new Set<string>();
    let animFrame: number | null = null;

    const updateDriveInput = (dtSec = 0.04) => {
      const isPreview = usePreviewDrive.getState().active;

      let throttle = 0;
      let steer = 0;
      let brake = false;

      if (pressed.has('KeyW') || pressed.has('ArrowUp')) throttle += 1;
      if (pressed.has('KeyS') || pressed.has('ArrowDown')) throttle -= 1;
      if (pressed.has('KeyA') || pressed.has('ArrowLeft')) steer -= 1;
      if (pressed.has('KeyD') || pressed.has('ArrowRight')) steer += 1;
      if (pressed.has('Space')) brake = true;

      if (isPreview) {
        usePreviewDrive.getState().updateGhostInput({ throttle, steer, brake }, dtSec);
        return;
      }

      const ctl = useControl.getState();
      if (!ctl.inputEnabled) return;
      controlActions.setInput('keyboard', { throttle, steer, brake });
    };

    // Smooth continuous loop while keys are held
    let lastTick = performance.now();
    const driveLoop = (now: number) => {
      const dt = Math.min((now - lastTick) / 1000, 0.1);
      lastTick = now;
      if (pressed.size > 0) {
        updateDriveInput(dt);
      }
      animFrame = requestAnimationFrame(driveLoop);
    };
    animFrame = requestAnimationFrame(driveLoop);

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) {
        return;
      }

      // Camera sub-view slots: Shift+1..5 (plain 1-4 stay the global tab shortcuts)
      if (e.shiftKey && /^Digit[1-5]$/.test(e.code) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        const dir = DIR_SLOTS[Number(e.code.slice(5)) - 1];
        const mc = useMapCamera.getState();
        if (dir && mc.active && mc.hasRobot()) mc.setFirstPersonDirection(dir);
        return;
      }

      // Cycle camera mode with 'c' or 'C'
      if ((e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        if (useMapCamera.getState().hasRobot()) useMapCamera.getState().cycleCameraMode();
        return;
      }

      // Toggle immersive HUD with 'h' or 'H'
      if ((e.key === 'h' || e.key === 'H') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        useMapCamera.getState().toggleImmersiveHud();
        return;
      }

      // Driving keys
      if (['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        const isPreview = usePreviewDrive.getState().active;
        const ctl = useControl.getState();
        if (isPreview || ctl.inputEnabled) {
          e.preventDefault();
          pressed.add(e.code);
          updateDriveInput();
        }
        return;
      }

      // Tool key: L (lamp toggle)
      if ((e.key === 'l' || e.key === 'L') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const ctl = useControl.getState();
        if (ctl.inputEnabled && ctl.robotId) {
          e.preventDefault();
          const r = useWorld.getState().robots[ctl.robotId];
          const curLamp = r?.control?.lamp ?? false;
          controlActions.tool(curLamp ? 'lamp_off' : 'lamp_on');
        }
        return;
      }

      // Tool key: E (inspection / scan)
      if ((e.key === 'e' || e.key === 'E') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const ctl = useControl.getState();
        if (ctl.inputEnabled) {
          e.preventDefault();
          controlActions.tool('scan');
        }
        return;
      }

      // Manipulation key: P (Pick / Grasp contact)
      if ((e.key === 'p' || e.key === 'P') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const ctl = useControl.getState();
        if (ctl.inputEnabled) {
          e.preventDefault();
          controlActions.pick();
        }
        return;
      }

      // Manipulation key: O (Place / Seat in fixture)
      if ((e.key === 'o' || e.key === 'O') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const ctl = useControl.getState();
        if (ctl.inputEnabled) {
          e.preventDefault();
          controlActions.place();
        }
        return;
      }

      // Manipulation key: G (Toggle Gripper)
      if ((e.key === 'g' || e.key === 'G') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const ctl = useControl.getState();
        if (ctl.inputEnabled && ctl.robotId) {
          e.preventDefault();
          const r = useWorld.getState().robots[ctl.robotId];
          const curAp = r?.gripper_aperture_m ?? 0.04;
          const nextAp = curAp > 0.02 ? 0.01 : 0.05;
          controlActions.setGripper(nextAp);
        }
        return;
      }

      // Crawler key: T (Brush / Clean in-pipe deposit)
      if ((e.key === 't' || e.key === 'T') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const ctl = useControl.getState();
        if (ctl.inputEnabled) {
          e.preventDefault();
          controlActions.cleanDeposit();
        }
        return;
      }

      // Escape key to release, safe-stop, or exit ghost preview
      if (e.key === 'Escape') {
        if (usePreviewDrive.getState().active) {
          e.preventDefault();
          usePreviewDrive.getState().exitPreview();
          return;
        }
        const ctl = useControl.getState();
        if (ctl.state === 'MANUAL_DRIVING' || ctl.state === 'MANUAL_ARMED') {
          e.preventDefault();
          controlActions.release('operator_release');
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        pressed.delete(e.code);
        updateDriveInput();
      }
    };

    const onBlur = () => {
      pressed.clear();
      updateDriveInput();
      const ctl = useControl.getState();
      if (ctl.state === 'MANUAL_DRIVING' || ctl.state === 'MANUAL_ARMED') {
        controlActions.safeStop('client_hidden');
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        pressed.clear();
        updateDriveInput();
        const ctl = useControl.getState();
        if (ctl.state === 'MANUAL_DRIVING' || ctl.state === 'MANUAL_ARMED') {
          controlActions.safeStop('client_hidden');
        }
      }
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      if (animFrame !== null) cancelAnimationFrame(animFrame);
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      pressed.clear();
    };
  }, [enabled]);
}
