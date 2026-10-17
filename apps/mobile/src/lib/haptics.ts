import * as Haptics from 'expo-haptics';

/** Thin wrapper so every call site is fire-and-forget and platform failures never surface. */
const safe = (p: Promise<void>) => void p.catch(() => undefined);

export const haptic = {
  select: () => safe(Haptics.selectionAsync()),
  light: () => safe(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  medium: () => safe(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  rigid: () => safe(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid)),
  success: () => safe(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  warning: () => safe(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  error: () => safe(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
};
