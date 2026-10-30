import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import PixelSprite from './PixelSprite';
import { FORMS, PALETTE } from './creatures';

export type DigiMood =
  | 'sleeping'
  | 'tired'
  | 'sad'
  | 'okay'
  | 'happy'
  | 'thrilled';

export type DigiReaction =
  | 'feed'
  | 'play'
  | 'sleep'
  | 'wake'
  | 'pet'
  | 'hug'
  | 'dizzy'
  | 'levelup'
  | 'think'
  | 'chat'
  | 'sad'
  | 'poke';

export type DigiSpriteHandle = {
  react: (kind: DigiReaction) => void;
};

type Props = {
  mood: DigiMood;
  onTap: () => void;
  onDoubleTap: () => void;
  onLongPress: () => void;
};

const SPRITE = FORMS.drago.sprite;

/** Idle float per mood: how fast and how high Digi bobs. */
const IDLE: Record<DigiMood, { dur: number; lift: number; tilt: number }> = {
  sleeping: { dur: 2600, lift: 2, tilt: 6 }, // slumped to one side
  tired: { dur: 2200, lift: 3, tilt: 3 },
  sad: { dur: 2000, lift: 3, tilt: -5 }, // head drooping
  okay: { dur: 1400, lift: 5, tilt: 0 },
  happy: { dur: 1100, lift: 7, tilt: 0 },
  thrilled: { dur: 850, lift: 10, tilt: 0 },
};

function haptic(kind: DigiReaction) {
  const run =
    kind === 'levelup'
      ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      : kind === 'play' || kind === 'poke' || kind === 'dizzy'
        ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy)
        : kind === 'hug'
          ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
          : Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  run.catch(() => {});
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);

const DigiSprite = forwardRef<DigiSpriteHandle, Props>(
  ({ mood, onTap, onDoubleTap, onLongPress }, ref) => {
    // Continuous idle motion.
    const idleY = useSharedValue(0);
    const breathX = useSharedValue(1);
    const breathY = useSharedValue(1);
    const baseTilt = useSharedValue(0);
    // One-shot reactions, layered on top of the idle motion.
    const reactY = useSharedValue(0);
    const reactX = useSharedValue(0);
    const scale = useSharedValue(1);
    const scaleX = useSharedValue(1);
    const scaleY = useSharedValue(1);
    const rotate = useSharedValue(0);
    const opacity = useSharedValue(1);
    const press = useSharedValue(1);
    // Sleep "Zzz" that drifts upward.
    const zY = useSharedValue(0);
    const zOpacity = useSharedValue(0);

    const lastTap = useRef(0);
    const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const fidgetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const moodRef = useRef(mood);

    useEffect(() => {
      moodRef.current = mood;
    }, [mood]);

    // ---------- Idle float + resting pose ----------
    useEffect(() => {
      const { dur, lift, tilt } = IDLE[mood];
      cancelAnimation(idleY);
      idleY.value = withRepeat(
        withSequence(
          withTiming(-lift, { duration: dur, easing: Easing.inOut(Easing.sin) }),
          withTiming(0, { duration: dur, easing: Easing.inOut(Easing.sin) }),
        ),
        -1,
        false,
      );
      baseTilt.value = withTiming(tilt, { duration: 600, easing: Easing.out(Easing.quad) });
    }, [mood, idleY, baseTilt]);

    // ---------- Breathing (subtle squash & stretch) ----------
    useEffect(() => {
      const dur = mood === 'sleeping' ? 2400 : mood === 'thrilled' ? 700 : 1500;
      const amount = mood === 'sleeping' ? 0.04 : 0.025;
      cancelAnimation(breathX);
      cancelAnimation(breathY);
      breathX.value = withRepeat(
        withSequence(
          withTiming(1 + amount, { duration: dur, easing: Easing.inOut(Easing.sin) }),
          withTiming(1, { duration: dur, easing: Easing.inOut(Easing.sin) }),
        ),
        -1,
        false,
      );
      breathY.value = withRepeat(
        withSequence(
          withTiming(1 - amount, { duration: dur, easing: Easing.inOut(Easing.sin) }),
          withTiming(1, { duration: dur, easing: Easing.inOut(Easing.sin) }),
        ),
        -1,
        false,
      );
    }, [mood, breathX, breathY]);

    // ---------- Sleep dimming + floating Zzz ----------
    useEffect(() => {
      opacity.value = withTiming(mood === 'sleeping' ? 0.72 : 1, { duration: 400 });

      cancelAnimation(zY);
      cancelAnimation(zOpacity);
      if (mood === 'sleeping') {
        zY.value = withRepeat(
          withSequence(
            withTiming(0, { duration: 1 }),
            withTiming(-34, { duration: 2200, easing: Easing.out(Easing.quad) }),
          ),
          -1,
          false,
        );
        zOpacity.value = withRepeat(
          withSequence(
            withTiming(0, { duration: 1 }),
            withTiming(1, { duration: 500 }),
            withTiming(1, { duration: 900 }),
            withTiming(0, { duration: 800 }),
          ),
          -1,
          false,
        );
      } else {
        zOpacity.value = withTiming(0, { duration: 200 });
      }
    }, [mood, opacity, zY, zOpacity]);

    // ---------- Random fidgets so Digi never looks frozen ----------
    useEffect(() => {
      const schedule = () => {
        fidgetTimer.current = setTimeout(() => {
          const m = moodRef.current;
          if (m === 'sleeping') {
            // Occasional twitch in its sleep.
            rotate.value = withSequence(
              withTiming(2, { duration: 120 }),
              withTiming(-1, { duration: 160 }),
              withTiming(0, { duration: 200 }),
            );
          } else {
            const roll = Math.random();
            if (roll < 0.4) {
              // Look around: lean left, then right, then settle.
              const dir = Math.random() < 0.5 ? 1 : -1;
              rotate.value = withSequence(
                withTiming(6 * dir, { duration: 220, easing: Easing.out(Easing.quad) }),
                withDelay(350, withTiming(-5 * dir, { duration: 260 })),
                withDelay(300, withTiming(0, { duration: 220 })),
              );
            } else if (roll < 0.7) {
              // Shift weight: a little side-step and back.
              const dir = Math.random() < 0.5 ? 1 : -1;
              reactX.value = withSequence(
                withTiming(7 * dir, { duration: 260, easing: Easing.inOut(Easing.quad) }),
                withDelay(400, withTiming(0, { duration: 300, easing: Easing.inOut(Easing.quad) })),
              );
            } else if (m === 'happy' || m === 'thrilled') {
              // Excited little hop.
              reactY.value = withSequence(
                withTiming(-14, { duration: 130 }),
                withSpring(0, { damping: 9 }),
              );
            } else if (m === 'sad' || m === 'tired') {
              // Heavy sigh: squash down, then rise slowly.
              scaleY.value = withSequence(
                withTiming(0.92, { duration: 350, easing: Easing.inOut(Easing.quad) }),
                withTiming(1, { duration: 700, easing: Easing.inOut(Easing.quad) }),
              );
            } else {
              // Quick shiver / shake-off.
              rotate.value = withSequence(
                withTiming(3, { duration: 50 }),
                withTiming(-3, { duration: 50 }),
                withTiming(2, { duration: 50 }),
                withTiming(0, { duration: 60 }),
              );
            }
          }
          schedule();
        }, rand(4500, 11000));
      };
      schedule();
      return () => {
        if (fidgetTimer.current) clearTimeout(fidgetTimer.current);
      };
    }, [rotate, reactX, reactY, scaleY]);

    useEffect(
      () => () => {
        if (tapTimer.current) clearTimeout(tapTimer.current);
      },
      [],
    );

    // ---------- Reactions ----------
    useImperativeHandle(ref, () => ({
      react(kind) {
        haptic(kind);
        switch (kind) {
          case 'feed':
            // Chomp chomp: open wide, then a satisfied wobble.
            scaleY.value = withSequence(
              withTiming(1.18, { duration: 110 }),
              withTiming(0.9, { duration: 110 }),
              withTiming(1.14, { duration: 110 }),
              withTiming(0.95, { duration: 100 }),
              withSpring(1),
            );
            scaleX.value = withSequence(
              withTiming(0.94, { duration: 110 }),
              withTiming(1.08, { duration: 110 }),
              withTiming(0.96, { duration: 110 }),
              withSpring(1),
            );
            break;
          case 'play':
            // Anticipation squash, big jump, land with a bounce.
            scaleY.value = withSequence(
              withTiming(0.82, { duration: 90 }),
              withTiming(1.15, { duration: 120 }),
              withSpring(1, { damping: 7 }),
            );
            scaleX.value = withSequence(
              withTiming(1.15, { duration: 90 }),
              withTiming(0.9, { duration: 120 }),
              withSpring(1, { damping: 7 }),
            );
            reactY.value = withSequence(
              withTiming(4, { duration: 90 }),
              withTiming(-46, { duration: 170, easing: Easing.out(Easing.quad) }),
              withSpring(0, { damping: 8 }),
            );
            rotate.value = withSequence(
              withTiming(-14, { duration: 90 }),
              withTiming(14, { duration: 120 }),
              withTiming(-8, { duration: 90 }),
              withTiming(0, { duration: 90 }),
            );
            break;
          case 'sleep':
            opacity.value = withTiming(0.65, { duration: 500 });
            reactY.value = withSequence(
              withTiming(10, { duration: 500 }),
              withTiming(6, { duration: 400 }),
            );
            scaleY.value = withTiming(0.96, { duration: 500 });
            break;
          case 'wake':
            opacity.value = withTiming(1, { duration: 280 });
            scaleY.value = withSequence(
              withTiming(1.22, { duration: 200 }), // big stretch
              withSpring(1),
            );
            scaleX.value = withSequence(
              withTiming(0.92, { duration: 200 }),
              withSpring(1),
            );
            reactY.value = withSequence(
              withTiming(-18, { duration: 180 }),
              withSpring(0),
            );
            rotate.value = withSequence(
              withTiming(-6, { duration: 120 }),
              withTiming(6, { duration: 140 }),
              withTiming(0, { duration: 120 }),
            );
            break;
          case 'levelup':
            scale.value = withSequence(
              withTiming(1.45, { duration: 220 }),
              withTiming(1.25, { duration: 120 }),
              withTiming(1.5, { duration: 120 }),
              withSpring(1, { damping: 6 }),
            );
            rotate.value = withSequence(
              withTiming(360, { duration: 480, easing: Easing.inOut(Easing.cubic) }),
              withTiming(0, { duration: 1 }),
            );
            reactY.value = withSequence(
              withTiming(-30, { duration: 240 }),
              withSpring(0, { damping: 6 }),
            );
            break;
          case 'pet':
            // Happy wiggle, leaning into the hand.
            rotate.value = withSequence(
              withTiming(8, { duration: 70 }),
              withTiming(-8, { duration: 70 }),
              withTiming(5, { duration: 70 }),
              withTiming(0, { duration: 70 }),
            );
            scale.value = withSequence(
              withTiming(1.08, { duration: 90 }),
              withSpring(1),
            );
            break;
          case 'hug':
            // Squeeze: wide and short, then melt back slowly.
            scaleX.value = withSequence(
              withTiming(1.18, { duration: 180, easing: Easing.out(Easing.quad) }),
              withDelay(500, withSpring(1, { damping: 10 })),
            );
            scaleY.value = withSequence(
              withTiming(0.86, { duration: 180, easing: Easing.out(Easing.quad) }),
              withDelay(500, withSpring(1, { damping: 10 })),
            );
            rotate.value = withSequence(
              withTiming(-4, { duration: 200 }),
              withTiming(4, { duration: 600, easing: Easing.inOut(Easing.sin) }),
              withTiming(0, { duration: 300 }),
            );
            break;
          case 'dizzy':
            // Wobbly spin and a stagger.
            rotate.value = withSequence(
              withTiming(-25, { duration: 90 }),
              withTiming(25, { duration: 110 }),
              withTiming(-20, { duration: 110 }),
              withTiming(16, { duration: 120 }),
              withTiming(-10, { duration: 130 }),
              withTiming(5, { duration: 140 }),
              withSpring(0, { damping: 5 }),
            );
            reactX.value = withSequence(
              withTiming(-10, { duration: 120 }),
              withTiming(12, { duration: 140 }),
              withTiming(-8, { duration: 150 }),
              withSpring(0, { damping: 6 }),
            );
            scaleY.value = withSequence(
              withTiming(0.9, { duration: 400 }),
              withSpring(1),
            );
            break;
          case 'think':
            // Head tilt, hold, tilt back.
            rotate.value = withSequence(
              withTiming(-9, { duration: 180 }),
              withDelay(400, withTiming(7, { duration: 240 })),
              withTiming(0, { duration: 180 }),
            );
            break;
          case 'chat':
            scale.value = withSequence(
              withTiming(1.1, { duration: 120 }),
              withSpring(1),
            );
            reactY.value = withSequence(
              withTiming(-6, { duration: 110 }),
              withSpring(0),
            );
            break;
          case 'sad':
            // Slump and a slow sway.
            reactY.value = withSequence(
              withTiming(8, { duration: 220 }),
              withTiming(0, { duration: 500 }),
            );
            scaleY.value = withSequence(
              withTiming(0.93, { duration: 220 }),
              withTiming(1, { duration: 500 }),
            );
            rotate.value = withSequence(
              withTiming(-5, { duration: 300 }),
              withTiming(4, { duration: 500, easing: Easing.inOut(Easing.sin) }),
              withTiming(0, { duration: 300 }),
            );
            break;
          case 'poke':
            rotate.value = withSequence(
              withTiming(18, { duration: 80 }),
              withTiming(-18, { duration: 90 }),
              withTiming(10, { duration: 80 }),
              withTiming(0, { duration: 90 }),
            );
            reactY.value = withSequence(
              withTiming(-18, { duration: 90 }),
              withSpring(0),
            );
            break;
        }
      },
    }));

    const spriteStyle = useAnimatedStyle(() => ({
      opacity: opacity.value,
      transform: [
        { translateY: idleY.value + reactY.value },
        { translateX: reactX.value },
        { scale: scale.value * press.value },
        { scaleX: scaleX.value * breathX.value },
        { scaleY: scaleY.value * breathY.value },
        { rotate: `${rotate.value + baseTilt.value}deg` },
      ],
    }));

    // Ground shadow: shrinks and fades as Digi rises.
    const shadowStyle = useAnimatedStyle(() => {
      const height = -(idleY.value + reactY.value); // 0 on the ground
      const k = Math.max(0.45, 1 - height / 70);
      return {
        opacity: 0.22 * k * (mood === 'sleeping' ? 0.6 : 1),
        transform: [{ translateX: reactX.value * 0.6 }, { scaleX: k }, { scaleY: k }],
      };
    });

    const zStyle = useAnimatedStyle(() => ({
      opacity: zOpacity.value,
      transform: [{ translateY: zY.value }, { rotate: '-12deg' }],
    }));

    return (
      <Pressable
        hitSlop={16}
        delayLongPress={380}
        onLongPress={onLongPress}
        onPressIn={() => {
          press.value = withTiming(0.93, { duration: 80 });
        }}
        onPressOut={() => {
          press.value = withSpring(1, { damping: 8 });
        }}
        onPress={() => {
          const t = Date.now();
          if (t - lastTap.current < 280) {
            if (tapTimer.current) clearTimeout(tapTimer.current);
            lastTap.current = 0;
            onDoubleTap();
            return;
          }
          lastTap.current = t;
          tapTimer.current = setTimeout(onTap, 280);
        }}
      >
        <View style={styles.stage}>
          <Animated.Text style={[styles.zzz, zStyle]} pointerEvents="none">
            z z Z
          </Animated.Text>
          <Animated.View style={spriteStyle}>
            <PixelSprite rows={SPRITE} size={13} palette={PALETTE} />
          </Animated.View>
          <Animated.View style={[styles.shadow, shadowStyle]} pointerEvents="none" />
        </View>
      </Pressable>
    );
  },
);

DigiSprite.displayName = 'DigiSprite';

export default DigiSprite;

const styles = StyleSheet.create({
  stage: {
    alignItems: 'center',
    paddingTop: 14,
  },
  shadow: {
    marginTop: 6,
    width: 72,
    height: 14,
    borderRadius: 36,
    backgroundColor: '#3b2f7a',
  },
  zzz: {
    position: 'absolute',
    top: 0,
    right: -6,
    fontSize: 16,
    fontWeight: '900',
    color: '#6a5ac9',
    letterSpacing: 2,
  },
});