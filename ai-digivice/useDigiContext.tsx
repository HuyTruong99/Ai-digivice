// useDigiContext.ts — environment awareness for Digi.
// Gathers location, time and battery and returns them in the shape
// server.py expects under `context`.
//
// Install first (in the ai-digivice folder):
//   npx expo install expo-location expo-battery

import { useCallback, useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';
import * as Battery from 'expo-battery';

export type DigiContext = {
  lat?: number;
  lon?: number;
  place_name?: string;
  local_time?: string;
  battery?: number;
  motion?: string;
};

const REFRESH_MS = 2 * 60 * 1000; // re-check location every 2 minutes

export function useDigiContext() {
  const [context, setContext] = useState<DigiContext | null>(null);
  // ~100 m grid key; when it changes, Huy has arrived somewhere new.
  const [placeKey, setPlaceKey] = useState<string | null>(null);
  const [permission, setPermission] = useState<'unknown' | 'granted' | 'denied'>('unknown');
  const asked = useRef(false);

  const refresh = useCallback(async () => {
    const ctx: DigiContext = {
      local_time: new Date().toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }),
    };

    try {
      const level = await Battery.getBatteryLevelAsync();
      if (level >= 0) ctx.battery = Math.round(level * 100);
    } catch {}

    try {
      if (!asked.current) {
        asked.current = true;
        const { status } = await Location.requestForegroundPermissionsAsync();
        setPermission(status === 'granted' ? 'granted' : 'denied');
        if (status !== 'granted') { setContext(ctx); return; }
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      ctx.lat = lat;
      ctx.lon = lon;

      try {
        const [geo] = await Location.reverseGeocodeAsync(pos.coords);
        if (geo) {
          const name = geo.name && !/^\d/.test(geo.name) ? geo.name : geo.street;
          ctx.place_name = [name, geo.city].filter(Boolean).join(', ') || undefined;
        }
      } catch {}

      setPlaceKey(`${lat.toFixed(3)},${lon.toFixed(3)}`);
    } catch (e) {
      console.warn('location unavailable', e instanceof Error ? e.message : e);
    }

    setContext(ctx);
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return { context, placeKey, permission, refresh };
}