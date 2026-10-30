// PixelSprite.tsx — renders a pixel-art sprite from an array of row strings.
//
// Each character in a row maps to a color via `palette`. '.' and ' ' are transparent.
// Accepts the rows under several prop names (`rows`, `pixels`, `grid`, `sprite`, `form`)
// so it works with both App.tsx and any older FORMS[...] data you may still have.

import React, { memo, useMemo } from 'react';
import { View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

export type Palette = Record<string, string>;

export interface SpriteData {
  pixels?: string[];
  rows?: string[];
  grid?: string[];
  palette?: Palette;
}

export interface PixelSpriteProps {
  /** Preferred: array of equal-length row strings. */
  rows?: string[];
  /** Aliases for `rows`, kept for backwards compatibility. */
  pixels?: string[];
  grid?: string[];
  sprite?: string[] | SpriteData;
  /** A FORMS[...]-style object: either SpriteData itself, or { sprite: SpriteData }. */
  form?: SpriteData | { sprite?: string[] | SpriteData };
  /** Character → color. Merged on top of DEFAULT_PALETTE, so you only need to override what differs. */
  palette?: Palette;
  /** Size of one pixel cell in dp. */
  size?: number;
  /** Mirror horizontally. */
  flip?: boolean;
  /** Fallback color for characters missing from the palette (and for the placeholder). */
  color?: string;
  style?: StyleProp<ViewStyle>;
}

export const DEFAULT_PALETTE: Palette = {
  '#': '#222222', X: '#222222', '1': '#222222',
  R: '#e53935', O: '#fb8c00', Y: '#fdd835', G: '#43a047',
  B: '#1e88e5', P: '#8e24aa', W: '#ffffff', K: '#000000',
};

const TRANSPARENT = new Set(['.', ' ']);

function isSpriteData(v: unknown): v is SpriteData {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Pull the row array + optional palette out of whichever prop shape was passed. */
function resolveSource(props: PixelSpriteProps): { rows: string[] | undefined; palette: Palette | undefined } {
  // 1. Direct row props win.
  const direct = props.rows ?? props.pixels ?? props.grid;
  if (direct) return { rows: direct, palette: undefined };

  // 2. `sprite` can be an array or an object.
  let src: string[] | SpriteData | undefined = props.sprite;

  // 3. `form` can be SpriteData, or wrap a `sprite` field.
  if (!src && props.form) {
    const f = props.form as { sprite?: string[] | SpriteData } & SpriteData;
    src = f.sprite ?? f;
  }

  if (Array.isArray(src)) return { rows: src, palette: undefined };
  if (isSpriteData(src)) return { rows: src.pixels ?? src.rows ?? src.grid, palette: src.palette };
  return { rows: undefined, palette: undefined };
}

function PixelSpriteImpl(props: PixelSpriteProps) {
  const { size = 10, flip = false, color, style } = props;

  const { rows, palette: srcPalette } = resolveSource(props);

  // User palette overrides source palette overrides defaults.
  const palette = useMemo<Palette>(
    () => ({ ...DEFAULT_PALETTE, ...(srcPalette ?? {}), ...(props.palette ?? {}) }),
    [srcPalette, props.palette],
  );

  const valid = Array.isArray(rows) && rows.length > 0 && rows.some(r => typeof r === 'string' && r.length > 0);

  // Precompute cell colors so the render loop is just Views.
  const cells = useMemo(() => {
    if (!valid || !rows) return null;
    const width = Math.max(...rows.map(r => r.length));
    const fallback = color ?? '#222222';
    return rows.map(row =>
      Array.from({ length: width }, (_, x) => {
        const ch = row[x] ?? '.';
        return TRANSPARENT.has(ch) ? 'transparent' : (palette[ch] ?? fallback);
      }),
    );
  }, [rows, palette, color, valid]);

  if (!cells) {
    // Placeholder so the app still renders if sprite data is missing.
    return (
      <View
        style={[
          { width: 8 * size, height: 8 * size, backgroundColor: color ?? '#999999', borderRadius: size },
          style,
        ]}
      />
    );
  }

  const width = cells[0].length;
  const height = cells.length;

  return (
    <View
      style={[
        { width: width * size, height: height * size },
        flip && styles.flipped,
        style,
      ]}
      pointerEvents="none"
    >
      {cells.map((row, y) => (
        <View key={y} style={styles.row}>
          {row.map((bg, x) => (
            <View key={x} style={{ width: size, height: size, backgroundColor: bg }} />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  flipped: { transform: [{ scaleX: -1 }] },
});

// memo: the sprite only re-renders when its props change, not on every parent state update
// (App.tsx re-renders often — chat, bubble text, stat decay).
export const PixelSprite = memo(PixelSpriteImpl);
export default PixelSprite;