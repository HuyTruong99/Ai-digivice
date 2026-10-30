import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
  AppStateStatus,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Speech from 'expo-speech';
import AsyncStorage from '@react-native-async-storage/async-storage';
import DigiSprite, {
  type DigiReaction,
  type DigiSpriteHandle,
} from './DigiSprite';

// ============================================
// DIGI CONFIGURATION
// ============================================

// IMPORTANT: This must be your laptop's Wi-Fi IPv4 address.
// Change the IP if your laptop's address changes.
// The port must match the one uvicorn is started with, e.g.
//   uvicorn server:app --host 0.0.0.0 --port 8000 --reload
const DEFAULT_SERVER = 'http://172.18.27.166:8000';

// Bumped: the pet now stores timestamps, old saves are migrated below.
const STORAGE_KEY = 'digi-companion-v6';
const LEGACY_STORAGE_KEY = 'digi-companion-v5';

// Addresses this app shipped with before. A saved server that matches one
// of these was never typed in by the user, so the new DEFAULT_SERVER wins.
const OLD_DEFAULT_SERVERS = ['http://134.88.128.36:8000'];

const CHAT_TIMEOUT = 60000;
const THOUGHT_TIMEOUT = 15000;
const CHECK_TIMEOUT = 8000;
const THOUGHT_INTERVAL = 60000; // backend thoughts (when Auto is ON)
const TICK_INTERVAL = 60000; // passive stat changes once a minute
const QUIP_INTERVAL = 25000; // local idle chatter in the speech bubble
const NUDGE_INTERVAL = 35000; // "hey, look at me" pokes when ignored
const EVENT_INTERVAL = 50000; // random little things Digi does on its own
const REACTION_MS = 2600; // how long a reaction face/bubble stays up
const PET_COMBO_WINDOW = 1500; // ms between taps to count as a combo
const PET_COMBO_DIZZY = 6; // taps in a row before Digi gets dizzy

// Stat drift per minute while awake / asleep. Fractional values are
// accumulated, so Digi doesn't crash to zero in an hour and a half.
const ENERGY_DRAIN_PER_MIN = 0.5; // ~0 after 3h20m from 100
const HAPPY_DRAIN_PER_MIN = 0.35; // ~0 after ~5h from 100
const SLEEP_RECOVER_PER_MIN = 2;
const OFFLINE_FLOOR = 5; // catch-up decay never drops a stat below this
const AWAY_GREETING_MIN = 30; // minutes away before Digi says "welcome back"
const SHORT_AWAY_MIN = 5; // minutes away before Digi gives a time-of-day hello

const MAX_DISPLAY_MESSAGES = 30; // kept on screen / in storage
const MAX_HISTORY_MESSAGES = 20; // sent to the backend

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Local-only bubble (e.g. connection error). Never sent to the backend. */
  error?: boolean;
  /** Local-only flavour bubble (welcome back, level up). Never sent. */
  local?: boolean;
};

type Pet = {
  energy: number;
  happiness: number;
  xp: number;
  sleeping: boolean;
  /** Last time passive decay was applied (ms since epoch). */
  lastTick: number;
  /** Last time the user did anything with Digi (ms since epoch). */
  lastSeen: number;
};

type SavedData = {
  pet?: Partial<Pet>;
  messages?: Partial<Message>[];
  server?: string;
  /** True once the user has saved a URL by hand via "Edit URL". */
  serverCustom?: boolean;
  autoThought?: boolean;
  voice?: boolean;
};

type Mood = 'sleeping' | 'tired' | 'sad' | 'okay' | 'happy' | 'thrilled';
type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'night';

const now = () => Date.now();

const INITIAL_PET: Pet = {
  energy: 80,
  happiness: 80,
  xp: 0,
  sleeping: false,
  lastTick: now(),
  lastSeen: now(),
};

let idCounter = 0;
const makeId = () => `${now().toString(36)}-${(idCounter++).toString(36)}`;

const makeMessage = (
  role: Message['role'],
  content: string,
  extra: Partial<Message> = {},
): Message => ({ id: makeId(), role, content, ...extra });

const WELCOME_MESSAGE: Message = makeMessage(
  'assistant',
  "Hi! I'm Digi, your AI companion! Let's grow together!",
);

const clamp = (value: number) => Math.max(0, Math.min(100, value));
const pick = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)];

// ---------- Mood & personality helpers ----------

function getMood(pet: Pet): Mood {
  if (pet.sleeping) return 'sleeping';
  if (pet.energy < 20) return 'tired';
  if (pet.happiness < 30) return 'sad';
  if (pet.happiness >= 85 && pet.energy >= 50) return 'thrilled';
  if (pet.happiness >= 60) return 'happy';
  return 'okay';
}

function getTimeOfDay(date = new Date()): TimeOfDay {
  const h = date.getHours();
  if (h < 5) return 'night';
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  if (h < 22) return 'evening';
  return 'night';
}

const MOOD_FACE: Record<Mood, string> = {
  sleeping: '😴',
  tired: '🥱',
  sad: '🥺',
  okay: '🐲',
  happy: '🐲',
  thrilled: '🤩',
};

const MOOD_LABEL: Record<Mood, string> = {
  sleeping: 'Sleeping... zzz',
  tired: 'Running on empty',
  sad: 'Feeling lonely',
  okay: 'Could use some attention',
  happy: 'Happy and curious!',
  thrilled: 'Bursting with joy!',
};

const MOOD_QUIPS: Record<Mood, string[]> = {
  sleeping: ['zzz...', '*snore*', 'mmm... dragon dreams...', '*wing twitch*'],
  tired: [
    'So sleepy... maybe a nap?',
    'Could you feed me? My tail is drooping.',
    '*yawn* I need a recharge.',
    'Is it bedtime yet?',
  ],
  sad: [
    'Did you forget about me?',
    'I miss playing with you...',
    "It's quiet here. Say something?",
    'A hug would fix everything.',
  ],
  okay: [
    'What are you up to today?',
    'I wonder what adventure we will have today!',
    'Tell me something interesting!',
    'Hmm, do dragons dream of electric sheep?',
    'I counted my scales. I lost count.',
  ],
  happy: [
    "You're the best!",
    'Wanna play a game?',
    'I learned a new word today: SNUGGLE.',
    'Do you think clouds taste like cotton candy?',
    'If I had a hat, it would be a tiny one.',
  ],
  thrilled: [
    'Best. Day. EVER!',
    'I could fly to the moon right now!',
    'Rawr! (that means I love you)',
    'Level up soon? I can feel it!',
    'Look how shiny my scales are today!',
  ],
};

const TIME_QUIPS: Record<TimeOfDay, string[]> = {
  morning: ['Morning! Did you sleep well?', 'Breakfast time? Asking for a dragon.'],
  afternoon: ['Afternoon slump? Me too, a little.', 'Perfect time for a snack break.'],
  evening: ['How was your day? Tell me!', 'The evening light makes my scales glow.'],
  night: ["It's late! Night owl, huh?", 'Stars are out. I like counting them.'],
};

const TIME_GREETING: Record<TimeOfDay, string> = {
  morning: 'Good morning! Ready for a new day?',
  afternoon: 'Hey! Good to see you this afternoon.',
  evening: 'Evening! I was hoping you would stop by.',
  night: 'Up late? I will keep you company.',
};

function pickQuip(mood: Mood, exclude?: string): string {
  // Awake Digi sometimes comments on the time of day instead.
  const base =
    mood !== 'sleeping' && Math.random() < 0.25
      ? TIME_QUIPS[getTimeOfDay()]
      : MOOD_QUIPS[mood];
  const options = base.filter(q => q !== exclude);
  return options[Math.floor(Math.random() * options.length)] ?? base[0];
}

/**
 * Little things Digi does on its own while awake. Keeps the pet feeling
 * autonomous without hitting the backend.
 */
type DigiEvent = {
  line: string;
  face: string;
  motion: DigiReaction;
  burst?: string;
  energy?: number;
  happiness?: number;
  xp?: number;
  moods?: Mood[]; // only fire in these moods (default: any awake mood)
};

const DIGI_EVENTS: DigiEvent[] = [
  { line: 'Achoo! ...sorry, tiny fireball.', face: '🔥', motion: 'poke', burst: '✨ 🔥 ✨' },
  { line: '*hic* ... *hic* ... dragon hiccups!', face: '😳', motion: 'poke' },
  { line: 'I chased my tail. I did not catch it.', face: '😵‍💫', motion: 'play', energy: -2, happiness: 3 },
  { line: 'Ooh, I found a shiny pebble!', face: '🤩', motion: 'play', burst: '💎 ✨ 💎', happiness: 4, xp: 1 },
  { line: 'Practiced my roar. RAWR. Ten out of ten.', face: '😤', motion: 'play', xp: 2 },
  { line: 'Stretching my wings... much better.', face: '😌', motion: 'wake', energy: 1 },
  { line: 'I made up a song. It goes: la la RAWR.', face: '🎶', motion: 'chat', happiness: 2, moods: ['happy', 'thrilled'] },
  { line: 'Did a little dance. Nobody saw. Except you.', face: '💃', motion: 'play', burst: '🎵 ✨ 🎵', happiness: 3, moods: ['happy', 'thrilled', 'okay'] },
  { line: 'My tummy made a noise. Was that me?', face: '😅', motion: 'sad', moods: ['tired', 'okay'] },
  { line: '*sigh* ... just thinking about stuff.', face: '😔', motion: 'sad', moods: ['sad'] },
  { line: 'I drew you a picture in the dust. It is a circle.', face: '🎨', motion: 'chat', happiness: 2 },
  { line: 'Caught a dust bunny. Released it. Catch and release.', face: '🐰', motion: 'play', xp: 1 },
];

/** The backend only knows happy / neutral / tired / sad — map the richer app moods onto those. */
const BACKEND_MOOD: Record<Mood, 'happy' | 'neutral' | 'tired' | 'sad'> = {
  sleeping: 'tired',
  tired: 'tired',
  sad: 'sad',
  okay: 'neutral',
  happy: 'happy',
  thrilled: 'happy',
};

const levelOf = (pet: Pet) => Math.floor(pet.xp / 100) + 1;

/** Body shape the Python server expects for both /chat and /thought. */
function buildPetPayload(pet: Pet) {
  const minutesAway = Math.floor((now() - pet.lastSeen) / 60000);
  return {
    pet: {
      name: 'Digi',
      energy: Math.round(pet.energy),
      happiness: Math.round(pet.happiness),
      xp: pet.xp,
      sleeping: pet.sleeping,
      level: levelOf(pet),
      mood: BACKEND_MOOD[getMood(pet)],
    },
    ctx: {
      localTime: new Date().toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      }),
      minutesSinceLastInteraction: minutesAway,
    },
  };
}

function formatAway(minutes: number): string {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/** Apply passive stat drift for the time since `pet.lastTick`. */
function applyElapsed(pet: Pet, at: number, offline = false): Pet {
  const minutes = (at - pet.lastTick) / 60000;
  if (minutes < 0.5) return pet;

  let energy = pet.energy;
  let happiness = pet.happiness;

  if (pet.sleeping) {
    energy += minutes * SLEEP_RECOVER_PER_MIN;
  } else {
    energy -= minutes * ENERGY_DRAIN_PER_MIN;
    happiness -= minutes * HAPPY_DRAIN_PER_MIN;
  }

  const floor = offline ? OFFLINE_FLOOR : 0;

  // Keep the fractional value — rounding here would undo a 0.5/min drain
  // every tick and the bars would never move. Round only when displaying.
  return {
    ...pet,
    energy: clamp(Math.max(floor, energy)),
    happiness: clamp(Math.max(floor, happiness)),
    lastTick: at,
  };
}

/**
 * Local, instant reaction to what the user typed — fires alongside the
 * backend reply so Digi feels like it "heard" you, not just the server.
 */
function localReactionFor(text: string): { face: string; burst?: string } | null {
  const t = text.toLowerCase();
  if (/\b(love|adore|cute|best)\b/.test(t)) return { face: '🥰', burst: '💕 ✨ 💕' };
  if (/\b(sorry|apolog)/.test(t)) return { face: '🥺' };
  if (/\b(lol|haha|funny|joke)\b/.test(t)) return { face: '😂' };
  if (/\b(sad|tired|bad day|stress)/.test(t)) return { face: '🫂' };
  if (/\b(hi|hello|hey|yo)\b/.test(t)) return { face: '👋' };
  if (/\?$/.test(t.trim())) return { face: '🤔' };
  return null;
}

// ---------- Server helpers ----------

function normalizeServer(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(chat|thought)$/, '');
}

function isValidServer(value: string): boolean {
  // http(s)://host[:port] — port optional, no path.
  return /^https?:\/\/[^\s/:]+(:\d{1,5})?$/.test(value);
}

function extractText(data: unknown): string {
  if (typeof data === 'string') return data.trim();

  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;

    for (const key of [
      'reply',
      'response',
      'message',
      'answer',
      'thought',
      'text',
      'content',
    ]) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }

    // Optional OpenAI-style response structure.
    if (Array.isArray(obj.choices)) {
      const first = obj.choices[0] as
        | { message?: { content?: string } }
        | undefined;
      if (first?.message?.content) {
        return first.message.content.trim();
      }
    }
  }

  return '';
}

/** Optional face the server sends back with a reply or thought. */
function extractEmotion(data: unknown): string | null {
  if (data && typeof data === 'object') {
    const v = (data as Record<string, unknown>).emotion;
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function apiRequest(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    const raw = await response.text();

    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      // Preserve non-JSON responses for error reporting.
    }

    if (!response.ok) {
      let detail = '';
      if (data && typeof data === 'object') {
        const obj = data as Record<string, unknown>;
        detail = String(obj.detail ?? obj.error ?? '');
      }

      throw new Error(`HTTP ${response.status}${detail ? ': ' + detail : ''}`);
    }

    return data;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `Request timed out after ${Math.round(timeoutMs / 1000)}s`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================
// MAIN DIGI SCREEN
// ============================================

function DigiHome() {
  const [server, setServer] = useState(DEFAULT_SERVER);
  const [serverInput, setServerInput] = useState(DEFAULT_SERVER);
  const [serverCustom, setServerCustom] = useState(false);
  const [editingServer, setEditingServer] = useState(false);

  const [pet, setPet] = useState<Pet>(INITIAL_PET);
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);

  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('Ready');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [voice, setVoice] = useState(true);
  const [autoThought, setAutoThought] = useState(false);
  const [latestThought, setLatestThought] = useState(
    'I wonder what adventure we will have today!',
  );

  // Lively bits: speech bubble over the pet + a temporary reaction face.
  const [bubble, setBubble] = useState<string>('');
  const [reactionFace, setReactionFace] = useState<string | null>(null);
  const [burst, setBurst] = useState<string | null>(null);

  const [hydrated, setHydrated] = useState(false);

  const chatScrollRef = useRef<ScrollView>(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const checkingRef = useRef(false);
  const thoughtBusyRef = useRef(false);
  const serverRef = useRef(server);
  const petRef = useRef(pet);
  const messagesRef = useRef(messages);
  const voiceRef = useRef(voice);
  const levelRef = useRef(1);
  const reactionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastQuipRef = useRef<string | undefined>(undefined);
  const spriteRef = useRef<DigiSpriteHandle>(null);
  const burstTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const petComboRef = useRef({ count: 0, at: 0 });
  const lastEventRef = useRef<string | undefined>(undefined);
  const prevStatsRef = useRef({ energy: pet.energy, happiness: pet.happiness });
  const warnedRef = useRef({ energy: false, happiness: false });

  // Animations (native driver: transforms/opacity only). Digi's own
  // movement lives inside DigiSprite; these are for the bubble and bursts.
  const bubbleOpacity = useRef(new Animated.Value(0)).current;
  const burstScale = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    serverRef.current = server;
  }, [server]);

  useEffect(() => {
    petRef.current = pet;
  }, [pet]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    voiceRef.current = voice;
  }, [voice]);

  // ---------- Animation helpers ----------

  const showBubble = useCallback(
    (text: string) => {
      setBubble(text);
      bubbleOpacity.stopAnimation();
      Animated.sequence([
        Animated.timing(bubbleOpacity, {
          toValue: 1,
          duration: 180,
          useNativeDriver: true,
        }),
        Animated.delay(Math.max(REACTION_MS, 1800 + text.length * 45)),
        Animated.timing(bubbleOpacity, {
          toValue: 0,
          duration: 350,
          useNativeDriver: true,
        }),
      ]).start();
    },
    [bubbleOpacity],
  );

  const say = useCallback(async (text: string) => {
    if (!voiceRef.current || !text.trim()) return;

    try {
      await Speech.stop();
      Speech.speak(text, {
        language: 'en-US',
        rate: 0.95,
        pitch: 1.08,
      });
    } catch (error) {
      console.log('Speech error:', error);
    }
  }, []);

  /** Emoji burst over the pet (hearts, sparkles, confetti...). */
  const showBurst = useCallback(
    (text = '💕 ✨ 💕') => {
      setBurst(text);
      burstScale.stopAnimation();
      burstScale.setValue(0.4);
      Animated.sequence([
        Animated.spring(burstScale, {
          toValue: 1,
          friction: 4,
          useNativeDriver: true,
        }),
        Animated.delay(500),
        Animated.timing(burstScale, {
          toValue: 0,
          duration: 250,
          useNativeDriver: true,
        }),
      ]).start();
      if (burstTimer.current) clearTimeout(burstTimer.current);
      burstTimer.current = setTimeout(() => {
        if (mounted.current) setBurst(null);
      }, 1200);
    },
    [burstScale],
  );

  /**
   * Digi reacts: optional temporary face, speech bubble, animation, voice.
   */
  const react = useCallback(
    (line: string, face?: string, speak = true, motion?: DigiReaction) => {
      showBubble(line);
      spriteRef.current?.react(motion ?? 'chat');
      if (face) {
        setReactionFace(face);
        if (reactionTimer.current) clearTimeout(reactionTimer.current);
        reactionTimer.current = setTimeout(() => {
          if (mounted.current) setReactionFace(null);
        }, REACTION_MS);
      }
      if (speak) void say(line);
    },
    [say, showBubble],
  );

  const touch = useCallback(
    (updater: (prev: Pet) => Pet) => {
      setPet(prev => ({ ...updater(prev), lastSeen: now() }));
    },
    [],
  );

  const addAssistantMessage = useCallback(
    (content: string, extra: Partial<Message> = {}) => {
      setMessages(prev =>
        [...prev, makeMessage('assistant', content, extra)].slice(
          -MAX_DISPLAY_MESSAGES,
        ),
      );
    },
    [],
  );

  // ---------- Load saved Digi state (with offline catch-up) ----------
  useEffect(() => {
    mounted.current = true;

    const load = async () => {
      try {
        let stored = await AsyncStorage.getItem(STORAGE_KEY);
        if (!stored) {
          // Migrate from the previous save format.
          stored = await AsyncStorage.getItem(LEGACY_STORAGE_KEY);
        }

        if (stored) {
          const data: SavedData = JSON.parse(stored);
          const t = now();

          if (data.pet) {
            const lastTick = Number(data.pet.lastTick) || t;
            const lastSeen = Number(data.pet.lastSeen) || lastTick;

            const restored: Pet = {
              ...INITIAL_PET,
              energy: clamp(Number(data.pet.energy) || 0),
              happiness: clamp(Number(data.pet.happiness) || 0),
              xp: Math.max(0, Number(data.pet.xp) || 0),
              sleeping: Boolean(data.pet.sleeping),
              lastTick,
              lastSeen,
            };

            const caughtUp = applyElapsed(restored, t, true);
            levelRef.current = levelOf(caughtUp);
            prevStatsRef.current = {
              energy: caughtUp.energy,
              happiness: caughtUp.happiness,
            };
            warnedRef.current = {
              energy: caughtUp.energy < 20,
              happiness: caughtUp.happiness < 30,
            };
            setPet(caughtUp);

            const minutesAway = Math.floor((t - lastSeen) / 60000);
            if (minutesAway >= AWAY_GREETING_MIN) {
              const away = formatAway(minutesAway);
              const line = caughtUp.sleeping
                ? `*yawn* You were gone ${away}... I napped the whole time!`
                : caughtUp.happiness < 30
                  ? `You were gone ${away}! I missed you so much...`
                  : `Welcome back! You were away ${away}. Tell me everything!`;
              setMessages(prev =>
                [...prev, makeMessage('assistant', line, { local: true })].slice(
                  -MAX_DISPLAY_MESSAGES,
                ),
              );
              // Delay so the UI is on screen before Digi speaks.
              setTimeout(() => {
                if (!mounted.current) return;
                react(
                  line,
                  caughtUp.sleeping ? '😴' : caughtUp.happiness < 30 ? '🥺' : '🤗',
                  true,
                  caughtUp.sleeping ? 'sleep' : caughtUp.happiness < 30 ? 'sad' : 'wake',
                );
                if (!caughtUp.sleeping && caughtUp.happiness >= 30) showBurst('✨ 🎉 ✨');
              }, 600);
            } else if (minutesAway >= SHORT_AWAY_MIN && !caughtUp.sleeping) {
              // Short absence: a quick time-of-day hello, bubble only.
              setTimeout(() => {
                if (mounted.current) react(TIME_GREETING[getTimeOfDay()], '👋', false, 'wake');
              }, 600);
            }
          }

          if (Array.isArray(data.messages) && data.messages.length > 0) {
            const restoredMessages: Message[] = data.messages
              .filter(
                (m): m is Partial<Message> & { content: string } =>
                  !!m &&
                  typeof m.content === 'string' &&
                  (m.role === 'user' || m.role === 'assistant'),
              )
              .map(m => ({
                id: typeof m.id === 'string' ? m.id : makeId(),
                role: m.role as Message['role'],
                content: m.content,
                error: m.error,
                local: m.local,
              }))
              .slice(-MAX_DISPLAY_MESSAGES);
            // Keep any welcome-back line we just added at the end.
            setMessages(prev => {
              const extras = prev.filter(m => m.local);
              return [...restoredMessages, ...extras].slice(-MAX_DISPLAY_MESSAGES);
            });
          }

          if (data.server) {
            const normalized = normalizeServer(data.server);
            // Only honour a saved address the user typed in themselves.
            // Otherwise an old default would keep overriding DEFAULT_SERVER.
            // Migrate the previous incorrect campus IP even if it was
            // previously saved with serverCustom=true. Keep any other
            // manually entered address so users can change networks.
            const legacyDefault = OLD_DEFAULT_SERVERS.includes(normalized);
            const userTyped = !legacyDefault && (
              data.serverCustom === true || data.serverCustom === undefined
            );
            if (userTyped && isValidServer(normalized)) {
              setServer(normalized);
              setServerInput(normalized);
              setServerCustom(true);
            } else if (legacyDefault) {
              setServer(DEFAULT_SERVER);
              setServerInput(DEFAULT_SERVER);
              setServerCustom(false);
            }
          }
          if (typeof data.voice === 'boolean') setVoice(data.voice);
          if (typeof data.autoThought === 'boolean') {
            setAutoThought(data.autoThought);
          }
        }
      } catch (error) {
        console.log('Digi load error:', error);
      } finally {
        if (mounted.current) setHydrated(true);
      }
    };

    void load();

    return () => {
      mounted.current = false;
      if (reactionTimer.current) clearTimeout(reactionTimer.current);
      if (burstTimer.current) clearTimeout(burstTimer.current);
      void Speech.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- Save state ----------
  useEffect(() => {
    if (!hydrated) return;

    const data: SavedData = {
      pet,
      messages: messages.slice(-MAX_DISPLAY_MESSAGES),
      server,
      serverCustom,
      autoThought,
      voice,
    };

    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(data)).catch(error =>
      console.log('Save error:', error),
    );
  }, [pet, messages, server, serverCustom, autoThought, voice, hydrated]);

  // Keep the chat scrolled to the newest message.
  useEffect(() => {
    const id = setTimeout(() => {
      chatScrollRef.current?.scrollToEnd({ animated: true });
    }, 50);
    return () => clearTimeout(id);
  }, [messages, busy]);

  const mood = getMood(pet);

  // ---------- Passive "living pet" tick ----------
  useEffect(() => {
    if (!hydrated) return;

    const interval = setInterval(() => {
      setPet(prev => applyElapsed(prev, now()));
    }, TICK_INTERVAL);

    return () => clearInterval(interval);
  }, [hydrated]);

  // Catch up on time that passed while the app was backgrounded.
  useEffect(() => {
    if (!hydrated) return;

    const onChange = (state: AppStateStatus) => {
      if (state === 'active') {
        setPet(prev => applyElapsed(prev, now(), true));
      }
    };

    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, [hydrated]);

  // ---------- Stat warnings: Digi speaks up when a bar gets low ----------
  useEffect(() => {
    if (!hydrated) return;
    const prev = prevStatsRef.current;
    prevStatsRef.current = { energy: pet.energy, happiness: pet.happiness };
    if (pet.sleeping) return;

    if (pet.energy < 20 && prev.energy >= 20 && !warnedRef.current.energy) {
      warnedRef.current.energy = true;
      react('My tummy is rumbling... feed me?', '🥺', true, 'sad');
    } else if (pet.energy >= 40) {
      warnedRef.current.energy = false;
    }

    if (pet.happiness < 30 && prev.happiness >= 30 && !warnedRef.current.happiness) {
      warnedRef.current.happiness = true;
      react('I feel a bit lonely today...', '😢', true, 'sad');
    } else if (pet.happiness >= 50) {
      warnedRef.current.happiness = false;
    }
  }, [pet.energy, pet.happiness, pet.sleeping, hydrated, react]);

  // ---------- Idle chatter (local, no backend) ----------
  useEffect(() => {
    if (!hydrated) return;

    const interval = setInterval(() => {
      if (busyRef.current) return;
      const moodNow = getMood(petRef.current);
      // Don't talk over an existing bubble too often: 60% chance per tick.
      if (Math.random() > 0.6) return;
      const next = pickQuip(moodNow, lastQuipRef.current);
      lastQuipRef.current = next;
      showBubble(next);
      if (moodNow === 'sleeping') return;
      spriteRef.current?.react(moodNow === 'sad' || moodNow === 'tired' ? 'sad' : 'poke');
    }, QUIP_INTERVAL);

    return () => clearInterval(interval);
  }, [hydrated, showBubble]);

  // ---------- Spontaneous events: Digi does things on its own ----------
  useEffect(() => {
    if (!hydrated) return;

    const interval = setInterval(() => {
      if (busyRef.current || petRef.current.sleeping) return;
      if (Math.random() > 0.45) return;

      const moodNow = getMood(petRef.current);
      const candidates = DIGI_EVENTS.filter(
        e => (!e.moods || e.moods.includes(moodNow)) && e.line !== lastEventRef.current,
      );
      if (candidates.length === 0) return;

      const event = pick(candidates);
      lastEventRef.current = event.line;

      // Autonomous events don't bump lastSeen — they aren't the user's doing.
      if (event.energy || event.happiness || event.xp) {
        setPet(prev => ({
          ...prev,
          energy: clamp(prev.energy + (event.energy ?? 0)),
          happiness: clamp(prev.happiness + (event.happiness ?? 0)),
          xp: prev.xp + (event.xp ?? 0),
        }));
      }
      react(event.line, event.face, false, event.motion);
      if (event.burst) showBurst(event.burst);
    }, EVENT_INTERVAL);

    return () => clearInterval(interval);
  }, [hydrated, react, showBurst]);

  // If Huy ignores Digi, Digi pokes for attention.
  useEffect(() => {
    if (!hydrated) return;

    const interval = setInterval(() => {
      if (busyRef.current || petRef.current.sleeping) return;
      const minutesAway = (now() - petRef.current.lastSeen) / 60000;
      if (minutesAway < 1.2) return;
      if (Math.random() > 0.7) return;

      const moodNow = getMood(petRef.current);
      const lines =
        moodNow === 'sad'
          ? ['Hey... did you forget me?', 'I am still here, you know.']
          : moodNow === 'tired'
            ? ['*tap tap* A snack would be nice...', 'I could use a nap... or a hug.']
            : [
                'Pssst. Look at me!',
                'Wanna talk? I have thoughts.',
                'Double-tap me — I wanna play!',
                'Hold me for a snuggle!',
              ];
      showBubble(pick(lines));
      spriteRef.current?.react('poke');
    }, NUDGE_INTERVAL);

    return () => clearInterval(interval);
  }, [hydrated, showBubble]);

  // ---------- Level-up celebration ----------
  useEffect(() => {
    if (!hydrated) return;
    const level = levelOf(pet);
    if (level > levelRef.current) {
      levelRef.current = level;
      const line = `Level ${level}! I'm growing stronger!`;
      react(line, '🎉', true, 'levelup');
      showBurst('🎉 ⭐ 🎉');
      addAssistantMessage(`🎉 ${line}`, { local: true });
    } else if (level < levelRef.current) {
      levelRef.current = level;
    }
  }, [pet.xp, hydrated, react, addAssistantMessage, showBurst]);

  // ---------- Backend calls ----------

  const checkConnection = useCallback(async () => {
    if (checkingRef.current) return;

    checkingRef.current = true;
    setChecking(true);
    setStatus('Checking backend...');

    const base = normalizeServer(serverRef.current);

    try {
      // digi-server exposes /health with model + API-key status.
      const data = await apiRequest(`${base}/health`, { method: 'GET' }, CHECK_TIMEOUT);
      const health =
        data && typeof data === 'object' ? (data as Record<string, unknown>) : {};

      if (mounted.current) {
        setConnected(true);
        if (health.ok && health.api_key_set === false) {
          setStatus('Server reachable, but OPENAI_API_KEY is missing in its .env');
        } else if (health.ok) {
          const mem = typeof health.memories === 'number' ? health.memories : 0;
          setStatus(
            `Backend reachable — ${String(health.model ?? 'model')} • ${mem} memor${mem === 1 ? 'y' : 'ies'}`,
          );
          react('My brain is online! Let us chat!', '🧠', false, 'chat');
        } else {
          setStatus('Server reachable — but /health looks unfamiliar');
        }
      }
    } catch (error) {
      const message = errorMessage(error);
      console.log('Connection error:', message);

      if (!mounted.current) return;

      if (message.startsWith('HTTP ')) {
        // Host answered, just not with /health.
        setConnected(true);
        setStatus(`Server responded ${message}; is this digi-server?`);
      } else {
        const port = base.split(':').pop();
        setConnected(false);
        setStatus(`Cannot reach server. Check IP, Wi-Fi and that uvicorn runs on port ${port}.`);
      }
    } finally {
      checkingRef.current = false;
      if (mounted.current) setChecking(false);
    }
  }, [react]);

  const sendMessage = useCallback(async () => {
    const text = draft.trim();
    if (!text || busyRef.current) return;

    busyRef.current = true;
    setBusy(true);
    setDraft('');
    setStatus('Digi is thinking...');

    // Instant local reaction so Digi "hears" you before the server answers.
    const local = localReactionFor(text);
    showBubble(local ? 'Ooh! Let me think...' : 'Hmm... let me think!');
    setReactionFace(local?.face ?? '🤔');
    spriteRef.current?.react('think');
    if (local?.burst) showBurst(local.burst);

    const previous = messagesRef.current;
    const userMessage = makeMessage('user', text);
    const shown = [...previous, userMessage].slice(-MAX_DISPLAY_MESSAGES);

    messagesRef.current = shown;
    setMessages(shown);

    // Only real conversation turns go to the backend.
    // /chat gets the current message separately as `message`.
    // Do not include it in `history`, or Digi receives it twice.
    const history = previous
      .filter(m => !m.error && !m.local)
      .map(({ role, content }) => ({ role, content }))
      .slice(-MAX_HISTORY_MESSAGES);

    const base = normalizeServer(serverRef.current);

    try {
      const data = await apiRequest(
        `${base}/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: text,
            history,
            ...buildPetPayload(petRef.current),
          }),
        },
        CHAT_TIMEOUT,
      );

      const reply = extractText(data);
      if (!reply) {
        throw new Error('Backend returned no recognized reply text');
      }

      // The server answers 200 with a canned line + "error" when its LLM call failed.
      const serverError =
        data && typeof data === 'object'
          ? (data as Record<string, unknown>).error
          : undefined;

      if (mounted.current) {
        setConnected(true);
        setStatus(
          typeof serverError === 'string'
            ? `Server reached, but its AI call failed (${serverError}) — check the server log`
            : 'AI chat connected',
        );
        setReactionFace(null);
        const emotion = extractEmotion(data);
        if (emotion) {
          setReactionFace(emotion);
          if (reactionTimer.current) clearTimeout(reactionTimer.current);
          reactionTimer.current = setTimeout(() => {
            if (mounted.current) setReactionFace(null);
          }, REACTION_MS);
        }
        addAssistantMessage(reply);
        touch(prev => ({
          ...prev,
          happiness: clamp(prev.happiness + 2),
          xp: prev.xp + 3,
        }));
        spriteRef.current?.react('chat');
        showBubble(reply.length > 70 ? `${reply.slice(0, 67)}...` : reply);
        void say(reply);
      }
    } catch (error) {
      const message = errorMessage(error);
      console.log('Digi /chat error:', message);

      if (mounted.current) {
        // Roll back the unsent user turn so a retry doesn't duplicate it,
        // put the text back in the box, and show a local-only error bubble.
        messagesRef.current = previous;
        setMessages(previous);
        setDraft(text);
        setConnected(false);
        setStatus(`Chat failed: ${message}`);
        react("Uh oh, I can't reach my brain!", '😵', false, 'sad');
        addAssistantMessage(
          'My AI connection failed. Please check my server!',
          { error: true },
        );
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [draft, addAssistantMessage, say, showBubble, showBurst, react, touch]);

  const generateThought = useCallback(
    async (silent = false) => {
      if (thoughtBusyRef.current) return;

      thoughtBusyRef.current = true;
      if (!silent) setStatus('Asking Digi for a thought...');

      const base = normalizeServer(serverRef.current);

      try {
        const data = await apiRequest(
          `${base}/thought`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildPetPayload(petRef.current)),
          },
          THOUGHT_TIMEOUT,
        );

        // The server returns {"text": ""} when its LLM call failed.
        const thought = extractText(data);
        if (!thought) throw new Error('server had no thought (check its API key / log)');

        if (mounted.current) {
          setLatestThought(thought);
          setConnected(true);
          const face = extractEmotion(data) ?? '💭';
          if (!silent) {
            setStatus('New AI thought received');
            react(thought, face, true, 'think');
          } else {
            react(thought.length > 60 ? `${thought.slice(0, 57)}...` : thought, face, false, 'think');
          }
        }
      } catch (error) {
        const message = errorMessage(error);
        console.log('Digi /thought unavailable:', message);

        if (mounted.current && !silent) {
          setStatus(`Thought unavailable: ${message}`);
        }
      } finally {
        thoughtBusyRef.current = false;
      }
    },
    [react],
  );

  // Automatic thoughts are OFF initially.
  // Enable them after the /thought endpoint works.
  useEffect(() => {
    if (!autoThought || !hydrated) return;

    const interval = setInterval(() => {
      if (!busyRef.current && !petRef.current.sleeping) {
        void generateThought(true);
      }
    }, THOUGHT_INTERVAL);

    return () => clearInterval(interval);
  }, [autoThought, hydrated, generateThought]);

  // ---------- Care actions ----------

  const care = useCallback(
    (action: 'feed' | 'play' | 'sleep' | 'pet') => {
      const current = petRef.current;

      if (action === 'sleep') {
        const wasSleeping = current.sleeping;
        touch(prev => ({
          ...prev,
          sleeping: !prev.sleeping,
          energy: wasSleeping ? clamp(prev.energy + 20) : prev.energy,
        }));
        react(
          wasSleeping ? 'Good morning! I am awake!' : 'Good night! Sweet dreams!',
          wasSleeping ? '☀️' : '😴',
          true,
          wasSleeping ? 'wake' : 'sleep',
        );
        if (wasSleeping) showBurst('☀️ ✨ ☀️');
        return;
      }

      if (current.sleeping) {
        react(
          pick([
            'Zzz... I am sleeping. Wake me up first!',
            '*mumble* ...five more minutes...',
            'zzz... not now... dreaming of snacks...',
          ]),
          '😴',
          true,
          'sleep',
        );
        return;
      }

      if (action === 'pet') {
        // Rapid taps build a combo; too many and Digi gets dizzy.
        const t = now();
        const combo = petComboRef.current;
        combo.count = t - combo.at < PET_COMBO_WINDOW ? combo.count + 1 : 1;
        combo.at = t;

        if (combo.count >= PET_COMBO_DIZZY) {
          combo.count = 0;
          touch(prev => ({ ...prev, happiness: clamp(prev.happiness + 2) }));
          react('Whoa whoa, so many pets! I am dizzy!', '😵‍💫', true, 'dizzy');
          showBurst('💫 ⭐ 💫');
          return;
        }

        // Diminishing returns on spam-petting, but it always feels good.
        const gain = combo.count <= 2 ? 4 : combo.count <= 4 ? 2 : 1;
        touch(prev => ({
          ...prev,
          happiness: clamp(prev.happiness + gain),
          xp: prev.xp + 1,
        }));
        const lines =
          combo.count >= 3
            ? ['Hehe hehe, keep going!', 'More! More! Rawr!', 'This is the best day!']
            : [
                'Hehe, that tickles!',
                "Purrr... wait, dragons don't purr. Rawr!",
                'More head scratches please!',
                'You found my favourite spot!',
              ];
        showBurst();
        react(pick(lines), '🥰', combo.count <= 2, 'pet');
        return;
      }

      if (action === 'feed') {
        if (current.energy >= 100) {
          react('I am full! Let us play instead!', '😅', true, 'poke');
          return;
        }
        const starving = current.energy < 20;
        touch(prev => ({
          ...prev,
          energy: clamp(prev.energy + 15),
          happiness: clamp(prev.happiness + (starving ? 8 : 5)),
          xp: prev.xp + 5,
        }));
        react(
          starving
            ? 'FOOD! *munch munch* You saved me!'
            : pick([
                'Yummy! Thank you for feeding me!',
                '*crunch* Delicious! What was that?',
                'Mmm! My tail is wagging. Dragons do that, right?',
              ]),
          '😋',
          true,
          'feed',
        );
        showBurst('🍎 ✨ 🍎');
        return;
      }

      if (action === 'play') {
        if (current.energy < 10) {
          react('I am too tired. Please feed me!', '😩', true, 'sad');
          return;
        }
        touch(prev => ({
          ...prev,
          energy: clamp(prev.energy - 10),
          happiness: clamp(prev.happiness + 15),
          xp: prev.xp + 10,
        }));
        react(
          pick([
            'Yay! That was fun! Let us play again!',
            'Whee! Did you see that jump?',
            'Tag! You are it! ...wait, how do I run?',
          ]),
          '🎉',
          true,
          'play',
        );
        showBurst('🎮 ⭐ 🎮');
      }
    },
    [react, showBurst, touch],
  );

  const saveServer = () => {
    const normalized = normalizeServer(serverInput);

    if (!isValidServer(normalized)) {
      setStatus('Enter a valid address, e.g. http://192.168.1.10:8000');
      return;
    }

    serverRef.current = normalized;
    setServer(normalized);
    setServerInput(normalized);
    setServerCustom(true);
    setConnected(false);
    setEditingServer(false);
    setStatus('Server updated. Tap Test Server.');
  };

  const clearChat = () => {
    const fresh = [makeMessage('assistant', WELCOME_MESSAGE.content)];
    messagesRef.current = fresh;
    setMessages(fresh);
    setStatus('Chat cleared');
    react('Fresh start! What shall we talk about?', undefined, false, 'poke');
  };

  // ---------- Derived display values ----------

  const level = levelOf(pet);
  const xpInLevel = pet.xp % 100;
  const xpToNext = 100 - xpInLevel;
  const energyShown = Math.round(pet.energy);
  const happyShown = Math.round(pet.happiness);
  const petFace = reactionFace ?? MOOD_FACE[mood];
  const petMood = MOOD_LABEL[mood];

  const petAreaStyle = [
    styles.petArea,
    mood === 'sleeping' && styles.petAreaNight,
    mood === 'thrilled' && styles.petAreaThrilled,
    (mood === 'sad' || mood === 'tired') && styles.petAreaLow,
  ];

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <StatusBar style="dark" />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.title}>DIGI</Text>
          <Text style={styles.subtitle}>Your Living AI Companion</Text>

          {/* ---------- Pet card ---------- */}
          <View style={styles.card}>
            <View style={styles.headerRow}>
              <Text style={styles.sectionTitle}>My Digital Pet</Text>
              <Text style={styles.level}>Level {level}</Text>
            </View>

            <View style={petAreaStyle}>
              <Animated.View
                style={[styles.speechBubble, { opacity: bubbleOpacity }]}
                pointerEvents="none"
              >
                <Text style={styles.speechText} numberOfLines={3}>
                  {bubble}
                </Text>
                <View style={styles.speechTail} />
              </Animated.View>

              {burst ? (
                <Animated.Text
                  style={[styles.burst, { transform: [{ scale: burstScale }] }]}
                  pointerEvents="none"
                >
                  {burst}
                </Animated.Text>
              ) : null}

              <DigiSprite
                ref={spriteRef}
                mood={mood}
                onTap={() => care('pet')}
                onDoubleTap={() => care('play')}
                onLongPress={() => {
                  if (petRef.current.sleeping) {
                    react('Zzz... five more minutes...', '😴', true, 'sleep');
                    return;
                  }
                  touch(prev => ({
                    ...prev,
                    happiness: clamp(prev.happiness + 8),
                    xp: prev.xp + 2,
                  }));
                  showBurst('💗 🫧 💗');
                  react(
                    pick([
                      'Mmm, biggest hug ever. I feel so safe with you.',
                      '*squeeze* I never want to let go.',
                      'This is my favourite place in the whole world.',
                    ]),
                    '🤗',
                    true,
                    'hug',
                  );
                }}
              />

              <Text style={styles.reactionBadge}>{petFace}</Text>
              <Text style={styles.petName}>Digi</Text>
              <Text style={styles.petMood}>{petMood}</Text>
              <Text style={styles.petHint}>
                tap to pet · double-tap to play · hold to snuggle
              </Text>
            </View>

            <View style={styles.statRow}>
              <Text style={styles.statLabel}>Energy</Text>
              <View style={styles.statTrack}>
                <View
                  style={[
                    styles.energyFill,
                    pet.energy < 20 && styles.lowFill,
                    { width: `${energyShown}%` },
                  ]}
                />
              </View>
              <Text style={styles.statValue}>{energyShown}</Text>
            </View>

            <View style={styles.statRow}>
              <Text style={styles.statLabel}>Happy</Text>
              <View style={styles.statTrack}>
                <View
                  style={[
                    styles.happyFill,
                    pet.happiness < 30 && styles.lowFill,
                    { width: `${happyShown}%` },
                  ]}
                />
              </View>
              <Text style={styles.statValue}>{happyShown}</Text>
            </View>

            <View style={styles.statRow}>
              <Text style={styles.statLabel}>XP</Text>
              <View style={styles.statTrack}>
                <View style={[styles.xpFill, { width: `${xpInLevel}%` }]} />
              </View>
              <Text style={styles.statValue}>{xpInLevel}</Text>
            </View>

            <Text style={styles.xpText}>
              Total XP: {pet.xp} • {xpToNext} XP to Level {level + 1}
            </Text>

            <View style={styles.careRow}>
              <Pressable style={styles.careButton} onPress={() => care('feed')}>
                <Text style={styles.careEmoji}>🍎</Text>
                <Text style={styles.careText}>Feed</Text>
              </Pressable>

              <Pressable style={styles.careButton} onPress={() => care('play')}>
                <Text style={styles.careEmoji}>🎮</Text>
                <Text style={styles.careText}>Play</Text>
              </Pressable>

              <Pressable
                style={styles.careButton}
                onPress={() => care('sleep')}
              >
                <Text style={styles.careEmoji}>{pet.sleeping ? '☀️' : '💤'}</Text>
                <Text style={styles.careText}>
                  {pet.sleeping ? 'Wake' : 'Sleep'}
                </Text>
              </Pressable>
            </View>
          </View>

          {/* ---------- Thoughts card ---------- */}
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>💭 Digi's Thoughts</Text>
            <Text style={styles.thoughtText}>{latestThought}</Text>

            <View style={styles.actionRow}>
              <Pressable
                style={styles.secondaryButton}
                onPress={() => void generateThought()}
              >
                <Text style={styles.secondaryButtonText}>New Thought</Text>
              </Pressable>

              <Pressable
                style={[styles.secondaryButton, autoThought && styles.activeButton]}
                onPress={() => setAutoThought(v => !v)}
              >
                <Text style={styles.secondaryButtonText}>
                  Auto: {autoThought ? 'ON' : 'OFF'}
                </Text>
              </Pressable>
            </View>
          </View>

          {/* ---------- Chat card ---------- */}
          <View style={styles.card}>
            <View style={styles.headerRow}>
              <Text style={styles.sectionTitle}>🧠 AI Chat</Text>
              <Text
                style={[
                  styles.connectionText,
                  connected ? styles.connectedText : styles.disconnectedText,
                ]}
              >
                {connected ? '● Connected' : '○ Not verified'}
              </Text>
            </View>

            <ScrollView
              ref={chatScrollRef}
              style={styles.chatBox}
              contentContainerStyle={styles.chatContent}
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
            >
              {messages.map(message => (
                <View
                  key={message.id}
                  style={[
                    styles.messageBubble,
                    message.role === 'user'
                      ? styles.userBubble
                      : styles.digiBubble,
                    message.local && styles.localBubble,
                    message.error && styles.errorBubble,
                  ]}
                >
                  <Text style={styles.messageRole}>
                    {message.role === 'user' ? 'You' : 'Digi'}
                  </Text>
                  <Text style={styles.messageText}>{message.content}</Text>
                </View>
              ))}

              {busy && (
                <View style={styles.loadingRow}>
                  <ActivityIndicator color="#6856cf" />
                  <Text style={styles.loadingText}>Digi is thinking...</Text>
                </View>
              )}
            </ScrollView>

            <View style={styles.inputRow}>
              <TextInput
                style={styles.chatInput}
                placeholder="Say something to Digi..."
                placeholderTextColor="#8c8c9a"
                value={draft}
                onChangeText={setDraft}
                multiline
                maxLength={2000}
                editable={!busy}
                returnKeyType="send"
                submitBehavior="blurAndSubmit"
                onFocus={() => {
                  if (petRef.current.sleeping || busyRef.current) return;
                  spriteRef.current?.react('think');
                  showBubble(pick(["Yeah? I'm listening!", 'Ooh, a message for me?', "Go on, I'm all ears. Well, horns."]));
                }}
                onSubmitEditing={() => void sendMessage()}
              />

              <Pressable
                style={[
                  styles.sendButton,
                  (busy || !draft.trim()) && styles.disabledButton,
                ]}
                disabled={busy || !draft.trim()}
                onPress={() => void sendMessage()}
              >
                <Text style={styles.sendText}>Send</Text>
              </Pressable>
            </View>

            <View style={styles.actionRow}>
              <Pressable
                style={styles.secondaryButton}
                onPress={() => {
                  setVoice(v => !v);
                  void Speech.stop();
                }}
              >
                <Text style={styles.secondaryButtonText}>
                  🔊 Voice: {voice ? 'ON' : 'OFF'}
                </Text>
              </Pressable>

              <Pressable
                style={styles.secondaryButton}
                onPress={() => void Speech.stop()}
              >
                <Text style={styles.secondaryButtonText}>⏹ Stop Voice</Text>
              </Pressable>

              <Pressable style={styles.secondaryButton} onPress={clearChat}>
                <Text style={styles.secondaryButtonText}>🗑 Clear Chat</Text>
              </Pressable>
            </View>
          </View>

          {/* ---------- Server card ---------- */}
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>🔌 Server Connection</Text>

            <Text style={styles.serverText}>{server}</Text>

            {editingServer && (
              <TextInput
                style={styles.serverInput}
                value={serverInput}
                onChangeText={setServerInput}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="http://192.168.1.10:8000"
                placeholderTextColor="#8c8c9a"
                returnKeyType="done"
                onSubmitEditing={saveServer}
              />
            )}

            <View style={styles.actionRow}>
              <Pressable
                style={[styles.secondaryButton, checking && styles.disabledButton]}
                disabled={checking}
                onPress={() => void checkConnection()}
              >
                <Text style={styles.secondaryButtonText}>
                  {checking ? 'Checking...' : 'Test Server'}
                </Text>
              </Pressable>

              <Pressable
                style={styles.secondaryButton}
                onPress={() => {
                  if (editingServer) {
                    saveServer();
                  } else {
                    setServerInput(server);
                    setEditingServer(true);
                  }
                }}
              >
                <Text style={styles.secondaryButtonText}>
                  {editingServer ? 'Save URL' : 'Edit URL'}
                </Text>
              </Pressable>

              {editingServer && (
                <Pressable
                  style={styles.secondaryButton}
                  onPress={() => {
                    setServerInput(server);
                    setEditingServer(false);
                  }}
                >
                  <Text style={styles.secondaryButtonText}>Cancel</Text>
                </Pressable>
              )}
            </View>

            <Text style={styles.statusText}>Status: {status}</Text>
          </View>

          <Text style={styles.footer}>Digi • Powered by AI • Expo + Python</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <DigiHome />
    </SafeAreaProvider>
  );
}

// ============================================
// STYLES
// ============================================

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: {
    flex: 1,
    backgroundColor: '#f5f2ff',
  },
  content: {
    padding: 16,
    paddingBottom: 40,
    gap: 16,
  },
  title: {
    fontSize: 36,
    fontWeight: '900',
    color: '#5540b7',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: '#77738d',
    textAlign: 'center',
    marginTop: -12,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 22,
    padding: 16,
    gap: 12,
    borderWidth: 1,
    borderColor: '#ebe5ff',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#30275e',
  },
  level: {
    fontSize: 13,
    fontWeight: '700',
    color: '#6350c9',
  },
  petArea: {
    alignItems: 'center',
    backgroundColor: '#f5f0ff',
    borderRadius: 20,
    paddingTop: 64,
    paddingBottom: 16,
    paddingHorizontal: 20,
    overflow: 'hidden',
  },
  petAreaNight: {
    backgroundColor: '#e4dff6',
  },
  petAreaThrilled: {
    backgroundColor: '#fff4e3',
  },
  petAreaLow: {
    backgroundColor: '#eeeef5',
  },
  speechBubble: {
    position: 'absolute',
    top: 10,
    left: 16,
    right: 16,
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#ddd5f4',
    alignItems: 'center',
    zIndex: 3,
  },
  speechText: {
    fontSize: 13,
    color: '#4f3ca0',
    fontWeight: '600',
    textAlign: 'center',
  },
  speechTail: {
    position: 'absolute',
    bottom: -7,
    width: 12,
    height: 12,
    backgroundColor: '#fff',
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#ddd5f4',
    transform: [{ rotate: '45deg' }],
  },
  burst: {
    position: 'absolute',
    top: 52,
    zIndex: 2,
    fontSize: 20,
    letterSpacing: 6,
  },
  reactionBadge: {
    fontSize: 22,
    marginTop: 4,
  },
  petName: {
    fontSize: 24,
    fontWeight: '900',
    color: '#4f3ca0',
  },
  petMood: {
    fontSize: 13,
    color: '#77728f',
    marginTop: 4,
  },
  petHint: {
    fontSize: 11,
    color: '#a39dba',
    marginTop: 6,
  },
  statRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statLabel: {
    width: 55,
    fontSize: 13,
    fontWeight: '600',
    color: '#5a5571',
  },
  statTrack: {
    flex: 1,
    height: 12,
    backgroundColor: '#ebe7f6',
    borderRadius: 8,
    overflow: 'hidden',
  },
  energyFill: {
    height: '100%',
    backgroundColor: '#49bb86',
    borderRadius: 8,
  },
  happyFill: {
    height: '100%',
    backgroundColor: '#ffba55',
    borderRadius: 8,
  },
  xpFill: {
    height: '100%',
    backgroundColor: '#7b6bd9',
    borderRadius: 8,
  },
  lowFill: {
    backgroundColor: '#ef6b6b',
  },
  statValue: {
    width: 30,
    textAlign: 'right',
    color: '#4e4768',
    fontSize: 12,
  },
  xpText: {
    fontSize: 12,
    color: '#77728f',
    textAlign: 'center',
  },
  careRow: {
    flexDirection: 'row',
    gap: 10,
  },
  careButton: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: '#f1edff',
    borderRadius: 16,
    padding: 12,
    gap: 4,
  },
  careEmoji: {
    fontSize: 25,
  },
  careText: {
    fontWeight: '700',
    color: '#55449d',
  },
  thoughtText: {
    fontSize: 14,
    fontStyle: 'italic',
    lineHeight: 22,
    color: '#5a5276',
    backgroundColor: '#f7f4ff',
    padding: 14,
    borderRadius: 12,
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  secondaryButton: {
    flexGrow: 1,
    backgroundColor: '#ede8ff',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 11,
    alignItems: 'center',
  },
  activeButton: {
    backgroundColor: '#d4f4df',
  },
  secondaryButtonText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#5844aa',
  },
  connectionText: {
    fontSize: 12,
    fontWeight: '600',
  },
  connectedText: {
    color: '#4c9074',
  },
  disconnectedText: {
    color: '#9b94af',
  },
  chatBox: {
    minHeight: 180,
    maxHeight: 360,
    backgroundColor: '#faf9ff',
    borderRadius: 14,
  },
  chatContent: {
    gap: 10,
    padding: 10,
  },
  messageBubble: {
    maxWidth: '90%',
    padding: 12,
    borderRadius: 16,
    gap: 4,
  },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: '#e5dcff',
  },
  digiBubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#e9f5ee',
  },
  localBubble: {
    backgroundColor: '#fff4d6',
  },
  errorBubble: {
    backgroundColor: '#ffe9e6',
  },
  messageRole: {
    fontSize: 11,
    fontWeight: '800',
    color: '#52448b',
  },
  messageText: {
    color: '#2d2941',
    fontSize: 14,
    lineHeight: 20,
  },
  loadingRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    padding: 12,
  },
  loadingText: {
    fontSize: 12,
    color: '#77728f',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  chatInput: {
    flex: 1,
    minHeight: 48,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: '#ddd5f4',
    borderRadius: 12,
    backgroundColor: '#fff',
    padding: 12,
    fontSize: 14,
    color: '#302d41',
  },
  sendButton: {
    backgroundColor: '#6651c8',
    borderRadius: 12,
    paddingHorizontal: 18,
    paddingVertical: 15,
  },
  disabledButton: {
    opacity: 0.5,
  },
  sendText: {
    color: '#fff',
    fontWeight: '800',
  },
  serverText: {
    fontSize: 12,
    color: '#605b76',
  },
  serverInput: {
    borderWidth: 1,
    borderColor: '#d9d1f6',
    borderRadius: 10,
    padding: 12,
    color: '#28233e',
    fontSize: 13,
  },
  statusText: {
    fontSize: 12,
    color: '#77728f',
    lineHeight: 18,
  },
  footer: {
    textAlign: 'center',
    color: '#9b94af',
    fontSize: 11,
  },
});