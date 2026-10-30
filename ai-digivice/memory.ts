// memory.ts — Digi's long-term memory: facts about Huy, places visited, prompt builder.
// Install first:  npx expo install @react-native-async-storage/async-storage

import AsyncStorage from '@react-native-async-storage/async-storage';
import { nearestPOI, distanceMeters } from './pois';

// ---------- Types ----------

export type Fact = {
  key: string;      // snake_case, e.g. "university", "home", "favorite_food"
  value: string;    // e.g. "UMass Dartmouth"
  source: string;   // where it came from (snippet of the message, or "seed")
  at: number;       // timestamp
};

export type Place = {
  id: string;
  label: string;    // e.g. "UMass Dartmouth"
  role?: string;    // e.g. "university", "home", "gym"
  lat: number;
  lng: number;
  visits: number;
  firstSeen: number;
  lastSeen: number;
};

export type PlaceContext = {
  current: Place;
  recent: Place[];  // other places, most recent first
};

// A function that calls your LLM: (systemPrompt, userMessage) => reply text
export type LLMCall = (system: string, user: string) => Promise<string>;

// ---------- Storage helpers ----------

const FACTS_KEY = 'digi:facts';
const PLACES_KEY = 'digi:places';

async function load<T>(key: string, fallback: T): Promise<T> {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function save(key: string, value: unknown) {
  return AsyncStorage.setItem(key, JSON.stringify(value));
}

// ---------- Facts ----------

export function getFacts(): Promise<Fact[]> {
  return load<Fact[]>(FACTS_KEY, []);
}

export async function upsertFact(key: string, value: string, source = 'chat') {
  const k = key.trim().toLowerCase().replace(/\s+/g, '_');
  const facts = (await getFacts()).filter(f => f.key !== k);
  facts.push({ key: k, value: value.trim(), source, at: Date.now() });
  await save(FACTS_KEY, facts);
}

export async function forgetFact(key: string) {
  const facts = (await getFacts()).filter(f => f.key !== key);
  await save(FACTS_KEY, facts);
}

/** Ask a small/cheap model to pull durable facts out of a user message. */
export async function extractFacts(userMessage: string, llm: LLMCall) {
  const system = `Extract durable facts the user states about THEMSELVES from the message.
Return ONLY a JSON array of {"key": "...", "value": "..."}.
Keys are snake_case (examples: university, home, major, hometown, pet_name, favorite_food, job).
Ignore questions, opinions about others, and temporary states ("I'm tired").
If there are no facts, return [].`;

  let out = '';
  try { out = await llm(system, userMessage); } catch { return; }

  // tolerate ```json fences
  const match = out.match(/\[[\s\S]*\]/);
  if (!match) return;

  try {
    const items = JSON.parse(match[0]) as { key?: string; value?: string }[];
    for (const f of items) {
      if (f?.key && f?.value) await upsertFact(f.key, f.value, userMessage.slice(0, 60));
    }
  } catch { /* ignore bad JSON */ }
}

// ---------- Places ----------

const SAME_PLACE_RADIUS_M = 60; // small enough that library ≠ dorm
const NEW_VISIT_GAP_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Call this whenever you get a location fix (e.g. when the user sends a message).
 * `geocodedLabel` is whatever your reverse-geocoder returned ("UMass Dartmouth, North Dartmouth").
 */
export async function recordVisit(lat: number, lng: number, geocodedLabel: string): Promise<PlaceContext> {
  const places = await load<Place[]>(PLACES_KEY, []);
  const now = Date.now();

  let current = places.find(p => distanceMeters(p, { lat, lng }) < SAME_PLACE_RADIUS_M);

  if (current) {
    if (now - current.lastSeen > NEW_VISIT_GAP_MS) current.visits += 1;
    current.lastSeen = now;
  } else {
    // Prefer a known building from pois.ts; fall back to the geocoder's label
    const poi = nearestPOI(lat, lng);
    current = {
      id: String(now),
      label: poi ? poi.name : geocodedLabel,
      role: poi?.role,
      lat, lng, visits: 1, firstSeen: now, lastSeen: now,
    };
    places.push(current);
  }

  await save(PLACES_KEY, places);

  const recent = places
    .filter(p => p.id !== current!.id)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, 3);

  return { current, recent };
}

/** Give a place a meaningful name/role, e.g. labelPlace(id, "UMass Dartmouth", "university"). */
export async function labelPlace(id: string, label?: string, role?: string) {
  const places = await load<Place[]>(PLACES_KEY, []);
  const p = places.find(x => x.id === id);
  if (!p) return;
  if (label) p.label = label;
  if (role) p.role = role;
  await save(PLACES_KEY, places);
}

export function getPlaces(): Promise<Place[]> {
  return load<Place[]>(PLACES_KEY, []);
}

// ---------- Prompt builder ----------

function ago(ts: number) {
  const days = Math.round((Date.now() - ts) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/**
 * Build Digi's system prompt for this turn.
 * `lastReplies` = Digi's last 3–5 messages, so it doesn't repeat itself.
 */
export async function buildSystemPrompt(place: PlaceContext | null, lastReplies: string[]): Promise<string> {
  const facts = await getFacts();

  const factLines = facts.length
    ? facts.map(f => `- ${f.key}: ${f.value}`).join('\n')
    : '- (nothing yet — be curious and ask one question to learn something)';

  let placeBlock = 'Current place: unknown';
  if (place) {
    const { current, recent } = place;
    placeBlock =
      `Current place: ${current.label}${current.role ? ` (Huy's ${current.role})` : ''}, ` +
      `${current.visits} visit(s), first seen ${ago(current.firstSeen)}\n` +
      `Recent places: ${recent.length ? recent.map(p => `${p.label} (${ago(p.lastSeen)})`).join(', ') : 'none yet'}`;
  }

  const repeatBlock = lastReplies.length
    ? lastReplies.map(r => `"${r}"`).join(' | ')
    : '(none)';

  return `You are Digi, a small dragon companion who lives alongside Huy and grows with him.

Known facts about Huy:
${factLines}

${placeBlock}

Your recent replies (do NOT repeat these ideas or phrasings):
${repeatBlock}

Rules:
- 1–2 sentences, warm and playful, like a friend not an assistant.
- Never say you live "in the phone" or explain how the app works.
- Reference a specific known fact, place, or memory when relevant, OR ask one question to learn something new.
- If asked where you are and you already answered recently, say something NEW about the place (a memory, an observation, a question) instead of restating the location.
- If Huy tells you something about a place ("this is my university"), acknowledge it like you'll remember it.
- If the current place has no role yet, ask Huy what this place is so you can remember it.`;
}

// ---------- Teaching Digi a place by chat ----------

/**
 * Call this with the user's message BEFORE sending it to the LLM.
 * "this is the library" / "we're at my gym" → labels the current place.
 * Returns true if the message was a teaching command.
 */
export async function maybeTeachPlace(text: string, place: PlaceContext | null): Promise<boolean> {
  if (!place) return false;
  const m = text.match(/^(?:this is|we're at|we are at|i'?m at)\s+(?:the\s+|my\s+)?(.+?)[.!]?$/i);
  if (!m) return false;
  const label = m[1].trim();
  const roleGuess =
    /dorm|home|apartment|room/i.test(label) ? 'home' :
    /library/i.test(label) ? 'library' :
    /gym|fitness/i.test(label) ? 'gym' :
    /lab/i.test(label) ? 'lab' :
    /class|hall|building/i.test(label) ? 'classes' :
    /cafe|dining|food|restaurant/i.test(label) ? 'dining' : undefined;
  await labelPlace(place.current.id, label, roleGuess);
  place.current.label = label;
  if (roleGuess) place.current.role = roleGuess;
  return true;
}

// ---------- Seed (optional, for testing) ----------

/** Run once on first launch to see the difference immediately. */
export async function seedIfEmpty() {
  const facts = await getFacts();
  if (facts.length) return;
  await upsertFact('name', 'Huy', 'seed');
  await upsertFact('university', 'UMass Dartmouth', 'seed');
  await upsertFact('home', 'Ivy Dorm, UMass Dartmouth', 'seed');
  await upsertFact('major', 'MS Computer Science (Cybersecurity)', 'seed');
}