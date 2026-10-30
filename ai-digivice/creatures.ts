// creatures.ts — Digi's evolution tree.
//
// Sprites are 12×12 text grids (V-Pet LCD style). Each character maps to a
// colour in PALETTE; '.' is transparent. Edit freely or swap for PNGs later.
// Evolution is decided by TIME + HOW YOU RAISED IT, not by XP.

export type Stage = 'egg' | 'baby' | 'rookie' | 'champion' | 'ultimate';

export type Form = {
  id: string;
  name: string;
  stage: Stage;
  personality: string;      // injected into Digi's system prompt
  sprite: string[];         // 12 rows × 12 chars
  minutesToNext: number | null; // time in this stage before it can evolve
};

export const PALETTE: Record<string, string> = {
  k: '#0f172a', // outline / dark
  w: '#f8fafc', // white / eye shine
  y: '#facc15', // yellow
  o: '#fb923c', // orange
  r: '#f87171', // red
  p: '#f472b6', // pink
  b: '#7dd3fc', // light blue
  B: '#3b82f6', // blue
  g: '#4ade80', // green
  G: '#16a34a', // dark green
  v: '#a78bfa', // violet
  t: '#94a3b8', // grey
};

// Set to true while developing so you can watch evolutions happen in minutes.
export const FAST_EVOLUTION = true;
const T = (minutes: number) => (FAST_EVOLUTION ? Math.max(1, Math.round(minutes / 60)) : minutes);

export const FORMS: Record<string, Form> = {
  egg: {
    id: 'egg', name: 'Digi-Egg', stage: 'egg',
    personality: 'You are still an egg. You cannot talk yet — reply only with soft sounds like "..." or "*wobble*".',
    minutesToNext: T(5),
    sprite: [
      '............',
      '....kkkk....',
      '...kbbbbk...',
      '..kbbwbbbk..',
      '..kbbbbbbk..',
      '.kbbBbbbBbk.',
      '.kbbbbbbbbk.',
      '.kbBbbbbbbk.',
      '.kbbbbBbbbk.',
      '..kbbbbbbk..',
      '...kbbbbk...',
      '....kkkk....',
    ],
  },
  blob: {
    id: 'blob', name: 'Blobmon', stage: 'baby',
    personality: 'You are a brand-new baby creature: curious, a little clumsy, very few words, lots of wonder.',
    minutesToNext: T(60 * 6),
    sprite: [
      '............',
      '............',
      '....kkkk....',
      '...kyyyyk...',
      '..kyywyywk..',
      '..kykyyyky..',
      '..kyyyyyyk..',
      '..kykyykyk..',
      '..kyykkyyk..',
      '...kyyyyk...',
      '....kkkk....',
      '............',
    ],
  },
  pup: {
    id: 'pup', name: 'Pupmon', stage: 'rookie',
    personality: 'You are a young, energetic rookie: playful, loyal, eager to explore and learn with Huy.',
    minutesToNext: T(60 * 48),
    sprite: [
      '............',
      '.kk......kk.',
      '.kok....kok.',
      '.koookkoook.',
      '..koooooook.',
      '..kowkoowkk.',
      '..koookoook.',
      '..kokoooook.',
      '...kookook..',
      '..kkooooook.',
      '..kokkkkok..',
      '..kk....kk..',
    ],
  },
  // ---- Champion branch: decided by how Huy raised it ----
  wing: {
    id: 'wing', name: 'Wingmon', stage: 'champion',
    personality: 'You are an adventurous champion who loves travel and new places. You remember journeys vividly and get excited about going somewhere new.',
    minutesToNext: T(60 * 24 * 5),
    sprite: [
      '............',
      'kk...kk...kk',
      'kbk.kbbk.kbk',
      'kbbkbbbbkbbk',
      '.kbbbbbbbbk.',
      '..kbwbbwbk..',
      '..kbbbbbbk..',
      '..kbkbbkbk..',
      '...kbbbbk...',
      '..kkbkkbkk..',
      '..k.k..k.k..',
      '............',
    ],
  },
  owl: {
    id: 'owl', name: 'Owlmon', stage: 'champion',
    personality: 'You are a wise, bookish champion. You love questions, studying together, and explaining things clearly. Calm and encouraging.',
    minutesToNext: T(60 * 24 * 5),
    sprite: [
      '............',
      '..kk....kk..',
      '.kvvkkkkvvk.',
      '.kvvvvvvvvk.',
      '.kvwwvvwwvk.',
      '.kvwkvvkwvk.',
      '.kvvvvyvvvk.',
      '..kvvvvvvk..',
      '..kvkvvkvk..',
      '..kvvvvvvk..',
      '...kkkkkk...',
      '....k..k....',
    ],
  },
  grub: {
    id: 'grub', name: 'Grubmon', stage: 'champion',
    personality: 'You are a grumpy, sleepy champion who was a bit neglected. Sarcastic but secretly affectionate; you perk up when Huy pays attention.',
    minutesToNext: T(60 * 24 * 5),
    sprite: [
      '............',
      '............',
      '...kkkkkk...',
      '..kGGGGGGk..',
      '.kGkGGGGkGk.',
      '.kGGGGGGGGk.',
      '.kGGkkkkGGk.',
      '.kGGGGGGGGk.',
      '..kGgGGgGk..',
      '..kgggggg k.',
      '...kkkkkk...',
      '............',
    ],
  },
  // ---- Ultimate (placeholder: one form for now) ----
  drago: {
    id: 'drago', name: 'Dragomon', stage: 'ultimate',
    personality: 'You are a majestic ultimate-stage dragon, confident and protective. You have grown up alongside Huy and reference your shared history often.',
    minutesToNext: null,
    sprite: [
      '.k........k.',
      'krk......krk',
      'krrk....krrk',
      '.krrkkkkrrk.',
      '..krrrrrrk..',
      '..krwrrwrk..',
      '.krrrrrrrrk.',
      '.krykrrkyrk.',
      '.krrrryrrrk.',
      '..krrrrrrk..',
      '..kk.kk.kk..',
      '..k..k..k...',
    ],
  },
};

export const STARTING_FORM = 'egg';

/** Raising stats the branch rules look at. */
export type Raising = {
  places: number;        // distinct places discovered together
  chats: number;         // messages Huy sent
  careMistakes: number;  // times a stat hit zero / Digi was left starving
};

/** Decide the next form, or null if it can't evolve yet. */
export function nextForm(formId: string, minutesInStage: number, r: Raising): string | null {
  const form = FORMS[formId];
  if (!form || form.minutesToNext === null) return null;
  if (minutesInStage < form.minutesToNext) return null;

  switch (form.stage) {
    case 'egg':   return 'blob';
    case 'baby':  return 'pup';
    case 'rookie':
      // The branch: how did Huy raise it?
      if (r.careMistakes >= 3) return 'grub';
      if (r.places >= 3 && r.places >= r.chats / 10) return 'wing';
      return 'owl';
    case 'champion': return 'drago';
    default: return null;
  }
}

export const STAGE_LABEL: Record<Stage, string> = {
  egg: 'Egg', baby: 'Baby', rookie: 'Rookie', champion: 'Champion', ultimate: 'Ultimate',
};

export type Mood = 'happy' | 'neutral' | 'tired' | 'sad';

export const DIGI_ULTIMATE: Record<Mood, string[]> = {
  neutral: [ /* paste your current rows here, unchanged */ ],
  happy:   [ /* copy of neutral; change the mouth row to a smile, e.g. '..R.RR.R..' */ ],
  tired:   [ /* copy of neutral; make eyes a single line: 'XX' → '--' using palette key for half-closed */ ],
  sad:     [ /* copy of neutral; mouth row flipped to a frown */ ],
};

export function getMood(energy: number, happiness: number): Mood {
  if (energy < 30) return 'tired';
  if (happiness < 35) return 'sad';
  if (happiness > 80 && energy > 50) return 'happy';
  return 'neutral';
}