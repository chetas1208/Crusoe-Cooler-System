import { useState, useSyncExternalStore } from 'react';
import { TextInput, View } from 'react-native';
import { KeyRound } from 'lucide-react-native';
import { isAuthRequired, setAuthToken, subscribeAuth } from '@loopkeeper/core/client';
import { alpha, colors } from '@/theme';
import { Button, T } from '@/components/ui';

/**
 * Shown when the backend answered 401. The operator token is typed in here and kept in memory only: it is never part of
 * the bundle (anything in an app bundle is not a secret) and never persisted by this app.
 */
export function AuthGate() {
  const required = useSyncExternalStore(subscribeAuth, isAuthRequired, isAuthRequired);
  const [v, setV] = useState('');
  if (!required) return null;
  return (
    <View style={{ gap: 10, padding: 14, borderRadius: 16, backgroundColor: alpha(colors.warning, 0.08), borderWidth: 1, borderColor: alpha(colors.warning, 0.3) }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <KeyRound size={15} color={colors.warning} />
        <T v="headline" style={{ fontSize: 14.5 }}>
          The backend wants an operator token
        </T>
      </View>
      <T v="caption" color={colors.t2}>
        Paste it here. It is held in memory for this session only and is never stored or bundled.
      </T>
      <TextInput
        value={v}
        onChangeText={setV}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="Operator token"
        placeholderTextColor={colors.t4}
        accessibilityLabel="Operator token"
        style={{ height: 42, borderRadius: 11, paddingHorizontal: 12, color: colors.t1, backgroundColor: 'rgba(0,0,0,0.35)', borderWidth: 1, borderColor: colors.line2, fontFamily: 'GeistMono_500Medium', fontSize: 13 }}
      />
      <Button
        label="Use token"
        variant="primary"
        disabled={!v.trim()}
        onPress={() => {
          setAuthToken(v);
          setV('');
        }}
      />
    </View>
  );
}
