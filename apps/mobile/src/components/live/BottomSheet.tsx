import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { Gesture, GestureDetector, ScrollView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, type SharedValue } from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { colors } from '@/theme';
import { haptic } from '@/lib/haptics';

export type SnapId = 'peek' | 'half' | 'full';

interface SheetApi {
  snap: SnapId;
  setSnap: (s: SnapId) => void;
  /** visible sheet height above the tab bar, live (UI thread) */
  vis: SharedValue<number>;
  heights: Record<SnapId, number>;
  scrollTop: () => void;
}

const Ctx = createContext<SheetApi | null>(null);
export const useSheet = () => useContext(Ctx);

interface Props {
  /** distance from the screen bottom the sheet rests on (tab bar) */
  bottomInset: number;
  /** space reserved above the sheet when fully open (status card) */
  topReserve: number;
  peek: number;
  snap: SnapId;
  onSnapChange: (s: SnapId) => void;
  vis: SharedValue<number>;
  children: React.ReactNode;
  /** bumps → scroll content back to top (selection changed) */
  scrollKey?: string;
  onHeights?: (h: Record<SnapId, number>) => void;
}

const SPRING = { stiffness: 260, damping: 30, mass: 0.9 } as const;

/**
 * Three-detent glass sheet (peek / half / full) built on reanimated + gesture-handler.
 * Below `full` the content is non-scrollable and any drag moves the sheet; at `full` the content scrolls and a
 * downward pull at scroll-top hands control back to the sheet — the way Maps / Wallet sheets behave.
 */
export function BottomSheet({ bottomInset, topReserve, peek, snap, onSnapChange, vis, children, scrollKey, onHeights }: Props) {
  const { height: H } = useWindowDimensions();
  const avail = H - bottomInset - topReserve;
  const heights = useMemo<Record<SnapId, number>>(() => ({ peek, half: Math.max(peek + 120, Math.round(avail * 0.56)), full: Math.max(peek + 240, avail) }), [peek, avail]);
  const full = heights.full;
  const scrollRef = useRef<ScrollView>(null);
  const scrollY = useSharedValue(0);
  const startVis = useSharedValue(heights.peek);
  const dragging = useSharedValue(false);
  const scrollable = snap === 'full';

  useEffect(() => onHeights?.(heights), [heights, onHeights]);

  // animate to the controlled snap
  useEffect(() => {
    vis.set(withSpring(heights[snap], SPRING));
    if (snap !== 'full') scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [snap, heights, vis]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [scrollKey]);

  const commit = useCallback(
    (next: SnapId) => {
      if (next !== snap) haptic.light();
      onSnapChange(next);
    },
    [snap, onSnapChange],
  );

  const pan = Gesture.Pan()
    .activeOffsetY([-8, 8])
    .failOffsetX([-24, 24])
    // eslint-disable-next-line react-hooks/refs -- RNGH takes the ScrollView ref object itself; it is not read during render
    .simultaneousWithExternalGesture(scrollRef)
    .onBegin(() => {
      startVis.set(vis.get());
      dragging.set(false);
    })
    .onUpdate((e) => {
      const atFull = startVis.get() >= heights.full - 2;
      if (!dragging.get() && atFull && (scrollY.get() > 1 || e.translationY <= 0)) return;
      dragging.set(true);
      const next = startVis.get() - e.translationY;
      // rubber-band beyond the ends
      const lo = heights.peek;
      const hi = heights.full;
      vis.set(next < lo ? lo - Math.sqrt(lo - next) * 3 : next > hi ? hi + Math.sqrt(next - hi) * 3 : next);
    })
    .onEnd((e) => {
      if (!dragging.get()) return;
      dragging.set(false);
      const projected = vis.get() - e.velocityY * 0.18;
      const stops: [SnapId, number][] = [
        ['peek', heights.peek],
        ['half', heights.half],
        ['full', heights.full],
      ];
      let best: SnapId = 'peek';
      let bd = Infinity;
      for (const [id, h] of stops) {
        const d = Math.abs(projected - h);
        if (d < bd) {
          bd = d;
          best = id;
        }
      }
      vis.set(withSpring(heights[best], { ...SPRING, velocity: -e.velocityY }));
      runOnJS(commit)(best);
    });

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: full - vis.get() }] }));

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      scrollY.set(e.nativeEvent.contentOffset.y);
    },
    [scrollY],
  );

  const api = useMemo<SheetApi>(() => ({ snap, setSnap: onSnapChange, vis, heights, scrollTop: () => scrollRef.current?.scrollTo({ y: 0, animated: true }) }), [snap, onSnapChange, vis, heights]);

  return (
    <Ctx.Provider value={api}>
      <Animated.View pointerEvents="box-none" style={[{ position: 'absolute', left: 0, right: 0, bottom: bottomInset - 0, height: full }, sheetStyle]}>
        <GestureDetector gesture={pan}>
          <View style={{ flex: 1, borderTopLeftRadius: 26, borderTopRightRadius: 26, overflow: 'hidden' }}>
            <BlurView intensity={55} tint="dark" style={StyleSheet.absoluteFill} />
            <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(12,15,20,0.80)' }]} />
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderTopLeftRadius: 26, borderTopRightRadius: 26, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line2, borderBottomWidth: 0 }]} />
            <View style={{ alignItems: 'center', paddingTop: 8, paddingBottom: 6 }}>
              <View style={{ width: 38, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.22)' }} />
            </View>
            <ScrollView
              ref={scrollRef}
              scrollEnabled={scrollable}
              bounces={false}
              onScroll={onScroll}
              scrollEventThrottle={16}
              showsVerticalScrollIndicator={scrollable}
              contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: bottomInset + 36 }}
            >
              {children}
            </ScrollView>
          </View>
        </GestureDetector>
      </Animated.View>
    </Ctx.Provider>
  );
}
