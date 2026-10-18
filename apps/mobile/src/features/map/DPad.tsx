import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, OctagonX } from 'lucide-react-native';
import { alpha, colors } from '@/theme';
import { PressableScale, T } from '@/components/ui';

export interface PadInput {
  throttle: number;
  steer: number;
  brake: boolean;
}

type Held = { up: boolean; down: boolean; left: boolean; right: boolean; brake: boolean };
const NONE: Held = { up: false, down: false, left: false, right: false, brake: false };

function Key({ icon: Icon, label, on, disabled, onChange, tone }: { icon: typeof ArrowUp; label: string; on: boolean; disabled: boolean; onChange: (down: boolean) => void; tone: string }) {
  return (
    <PressableScale
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      onPressIn={() => onChange(true)}
      onPressOut={() => onChange(false)}
      scaleTo={0.94}
      style={{ width: 64, height: 56, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? alpha(tone, 0.28) : 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: on ? tone : colors.line2, opacity: disabled ? 0.35 : 1 }}
    >
      <Icon size={22} color={on ? tone : colors.t1} strokeWidth={2.4} />
    </PressableScale>
  );
}

interface Props {
  disabled: boolean;
  tone: string;
  /** called when the held axes change and, while anything is held, at `hz`; always with zeros when everything is released */
  onInput: (v: PadInput, dtS: number) => void;
  hz?: number;
  steerLabel?: string;
}

function Pad({ disabled, tone, onInput, hz = 25, steerLabel }: Props) {
  const [held, setHeld] = useState<Held>(NONE);
  const ref = useRef<Held>(NONE);
  const cb = useRef(onInput);
  const last = useRef(0);
  useEffect(() => {
    cb.current = onInput;
  });

  const emit = (h: Held) => {
    const now = Date.now();
    const dt = last.current ? Math.min((now - last.current) / 1000, 0.2) : 1 / hz;
    last.current = now;
    cb.current({ throttle: (h.up ? 1 : 0) - (h.down ? 1 : 0), steer: (h.right ? 1 : 0) - (h.left ? 1 : 0), brake: h.brake }, dt);
  };

  // every change of the held keys is emitted at once; while anything stays held it repeats at `hz`
  useEffect(() => {
    ref.current = held;
    emit(held);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [held]);

  useEffect(() => {
    const id = setInterval(() => {
      if (Object.values(ref.current).some(Boolean)) emit(ref.current);
      else last.current = 0;
    }, 1000 / hz);
    return () => {
      clearInterval(id);
      // unmount (or the pad was disabled, which remounts it): the input is zero from this instant
      ref.current = NONE;
      cb.current({ throttle: 0, steer: 0, brake: false }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hz]);

  const set = (k: keyof Held) => (down: boolean) => setHeld((h) => (h[k] === down ? h : { ...h, [k]: down }));
  return (
    <View style={{ alignItems: 'center', gap: 8 }}>
      <Key icon={ArrowUp} label="Forward" on={held.up} disabled={disabled} onChange={set('up')} tone={tone} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Key icon={ArrowLeft} label={steerLabel ? `${steerLabel} left` : 'Left'} on={held.left} disabled={disabled} onChange={set('left')} tone={tone} />
        <Key icon={ArrowDown} label="Reverse" on={held.down} disabled={disabled} onChange={set('down')} tone={tone} />
        <Key icon={ArrowRight} label={steerLabel ? `${steerLabel} right` : 'Right'} on={held.right} disabled={disabled} onChange={set('right')} tone={tone} />
      </View>
      <PressableScale
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel="Brake"
        onPressIn={() => set('brake')(true)}
        onPressOut={() => set('brake')(false)}
        scaleTo={0.96}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 40, paddingHorizontal: 22, borderRadius: 12, backgroundColor: held.brake ? alpha(colors.critical, 0.3) : 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: held.brake ? colors.critical : colors.line2, opacity: disabled ? 0.35 : 1 }}
      >
        <OctagonX size={16} color={held.brake ? colors.critical : colors.t2} />
        <T v="caption" color={held.brake ? colors.critical : colors.t2}>
          Brake
        </T>
      </PressableScale>
    </View>
  );
}

/**
 * Hold-to-drive pad. Whenever it is disabled (no ghost / no lease yet, or the lease ended) the pad is remounted, which drops
 * every held key and emits a zero input — input can never outlive the permission to give it.
 */
export function DPad(props: Props) {
  return <Pad key={props.disabled ? 'off' : 'on'} {...props} />;
}
