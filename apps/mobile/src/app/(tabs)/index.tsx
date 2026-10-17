import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { Extrapolation, interpolate, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useView } from '@loopkeeper/scene';
import { useWorld } from '@loopkeeper/core/store';
import { colors } from '@/theme';
import { RENDER_SCALE } from '@/lib/quality';
import { useTabBarHeight } from '@/components/TabBar';
import { useLinkStatus } from '@/hooks/useConnection';
import { BottomSheet, type SnapId } from '@/components/live/BottomSheet';
import { FollowBadge, SceneControls } from '@/components/live/SceneControls';
import { PipeCamOverlay } from '@/components/live/PipeCam';
import { PresetChips } from '@/components/live/PresetChips';
import { SceneCanvas } from '@/components/live/SceneCanvas';
import { SheetContent } from '@/components/live/SheetContent';
import { StatusCard } from '@/components/live/StatusCard';
import { Toast } from '@/components/live/Toast';

const PEEK = 212;

/**
 * The sheet follows context. Driven by store subscriptions (not render-time effects): selecting something or
 * entering the pipe cam opens it to a useful detent, clearing returns it to peek, leaving the bore lands on half,
 * and a new approval request pulls the Hold / Approve banner into view once per request.
 */
function useSheetAutoSnap(setSnap: (v: SnapId | ((s: SnapId) => SnapId)) => void) {
  useEffect(() => {
    const known = (id: string | null) => {
      if (!id) return false;
      const w = useWorld.getState();
      return !!(w.robots[id] || w.edgesById[id] || w.assetsById[id]);
    };
    let had = false;
    let lastMode = useView.getState().mode;
    const unsubView = useView.subscribe((s) => {
      const has = known(s.selectedId) || s.mode === 'pipe';
      if (has && !had) setSnap((c) => (c === 'peek' ? 'half' : c));
      if (!has && had) {
        // an approval is waiting on the operator: land where Hold / Approve are reachable
        const waiting = Object.values(useWorld.getState().incidents).some((i) => i.approval?.status === 'pending' && !i.closed_tick);
        setSnap(waiting ? 'half' : 'peek');
      }
      if (lastMode === 'pipe' && s.mode !== 'pipe') setSnap('half');
      had = has;
      lastMode = s.mode;
    });
    let lastApproval: string | undefined;
    const unsubWorld = useWorld.subscribe((w) => {
      const id = Object.values(w.incidents).find((i) => i.approval?.status === 'pending' && !i.closed_tick)?.approval?.id;
      if (id && id !== lastApproval) {
        const v = useView.getState();
        if (!known(v.selectedId) && v.mode !== 'pipe') setSnap((c) => (c === 'peek' ? 'half' : c));
      }
      lastApproval = id;
    });
    return () => {
      unsubView();
      unsubWorld();
    };
  }, [setSnap]);
}

export default function LiveScreen() {
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const tabH = useTabBarHeight();
  const link = useLinkStatus();
  const mode = useView((s) => s.mode);
  const selected = useView((s) => s.selectedId);

  const [snap, setSnap] = useState<SnapId>('peek');
  const vis = useSharedValue(PEEK);
  const heights = useRef({ peek: PEEK, half: 380, full: 600 });
  const halfH = useSharedValue(380);
  const topReserve = insets.top + 8 + 132;

  useSheetAutoSnap(setSnap);

  const onHeights = useCallback(
    (h: Record<SnapId, number>) => {
      heights.current = h;
      halfH.set(h.half);
    },
    [halfH],
  );

  // keep the subject inside the free region between the status card and the sheet
  useEffect(() => {
    const bottom = (heights.current[snap] ?? PEEK) + 8;
    useView.getState().setInsets({ top: (insets.top + 150) * RENDER_SCALE, bottom: bottom * RENDER_SCALE, left: 0, right: 0 });
  }, [snap, insets.top]);

  const chipsStyle = useAnimatedStyle(() => ({
    bottom: vis.get() + 12,
    opacity: interpolate(vis.get(), [halfH.get() + 10, halfH.get() + 110], [1, 0], Extrapolation.CLAMP),
  }));
  const controlsStyle = useAnimatedStyle(() => ({
    opacity: interpolate(vis.get(), [halfH.get() + 40, halfH.get() + 120], [1, 0], Extrapolation.CLAMP),
  }));

  const scrollKey = useMemo(() => `${mode}:${selected ?? ''}`, [mode, selected]);
  const cardTop = insets.top + 8;
  const pipe = mode === 'pipe';

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SceneCanvas active={focused} />

      {/*
        Everything above the GL view lives in ONE always-mounted layer: overlays toggle by opacity or inside this
        layer, never by mounting/unmounting siblings of the canvas at the screen root (defensive — during bring-up,
        sibling insertions next to the expo-gl view coincided with a blank surface).
      */}
      <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(9,11,15,0.38)', opacity: link.degraded ? 1 : 0 }]} />
        <PipeCamOverlay topInset={cardTop + 84 + (link.degraded ? 76 : 0)} />

        {/* right-hand quick actions */}
        <Animated.View pointerEvents="box-none" style={[{ position: 'absolute', right: 16, top: cardTop + (link.degraded ? 76 : 0) + (pipe ? 218 : 134) }, controlsStyle]}>
          <SceneControls />
        </Animated.View>

        {/* camera presets ride on top of the sheet */}
        <Animated.View pointerEvents="box-none" style={[{ position: 'absolute', left: 0, right: 0, marginBottom: tabH }, chipsStyle]}>
          <PresetChips />
        </Animated.View>

        <BottomSheet bottomInset={tabH} topReserve={topReserve} peek={PEEK} snap={snap} onSnapChange={setSnap} vis={vis} scrollKey={scrollKey} onHeights={onHeights}>
          <SheetContent />
        </BottomSheet>

        <View pointerEvents="box-none" style={{ position: 'absolute', left: 16, right: 16, top: cardTop, gap: 10 }}>
          <StatusCard compact={pipe} />
          <FollowBadge />
        </View>

        <View pointerEvents="none" style={{ position: 'absolute', left: 16, right: 16, bottom: tabH + 14 }}>
          <Toast />
        </View>
      </View>
    </View>
  );
}
