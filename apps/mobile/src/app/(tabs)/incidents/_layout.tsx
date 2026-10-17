import { Stack } from 'expo-router';
import { colors } from '@/theme';

export default function IncidentsLayout() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: 'slide_from_right' }} />;
}
