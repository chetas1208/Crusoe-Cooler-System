import { useEffect } from 'react';
import { View } from 'react-native';
import { useView } from '@loopkeeper/scene';
import { useWorld } from '@loopkeeper/core/store';
import { SceneCanvas } from '@/components/live/SceneCanvas';
import { useMapSel } from './store';

/**
 * The shared 3D scene (@loopkeeper/scene) on R3F-native + expo-gl, native only. It was verified in the iOS Simulator by the
 * original author (see README); it has NOT been re-verified on a physical device. Selection is mirrored from the Map tab.
 */
export function Map3D({ height, active }: { height: number; active: boolean }) {
  const selected = useMapSel((s) => s.selectedId);
  useEffect(() => {
    if (useView.getState().selectedId !== selected) useView.getState().select(selected);
  }, [selected]);
  // taps in the scene select a robot in the roster too
  useEffect(
    () =>
      useView.subscribe((s) => {
        if (s.selectedId && s.selectedId !== useMapSel.getState().selectedId && useWorld.getState().robots[s.selectedId]) useMapSel.getState().select(s.selectedId);
      }),
    [],
  );
  return (
    <View style={{ height, borderRadius: 18, overflow: 'hidden' }}>
      <SceneCanvas active={active} />
    </View>
  );
}
