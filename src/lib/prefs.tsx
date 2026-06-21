import { createContext, useContext, useMemo, type ReactNode } from "react";
import { DEFAULT_PREFERENCES, type Preferences } from "./api";
import { DEFAULT_THEME, type IconTheme, resolveTheme } from "./fileIcons";

type PrefsValue = {
  prefs: Preferences;
  /** Bitmask of the storage's installed locales (0 = unknown). */
  installedLocales: number;
  /** The active icon theme, resolved from prefs.icon_theme + custom themes. */
  iconTheme: IconTheme;
};

const PrefsContext = createContext<PrefsValue>({
  prefs: DEFAULT_PREFERENCES,
  installedLocales: 0,
  iconTheme: DEFAULT_THEME,
});

export function PrefsProvider({
  prefs,
  installedLocales,
  children,
}: {
  prefs: Preferences | null | undefined;
  installedLocales: number;
  children: ReactNode;
}) {
  const value = useMemo<PrefsValue>(() => {
    const p = prefs ?? DEFAULT_PREFERENCES;
    return {
      prefs: p,
      installedLocales,
      iconTheme: resolveTheme(p.icon_theme, p.custom_icon_themes),
    };
  }, [prefs, installedLocales]);
  return (
    <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>
  );
}

export function usePrefs(): PrefsValue {
  return useContext(PrefsContext);
}

/// Whether an entry should be hidden when "hide other locales" is on. Neutral
/// entries (flags == 0) are always kept; an unknown installed locale never hides.
export function isForeignLocale(localeFlags: number, installed: number): boolean {
  if (localeFlags === 0) return false;
  if (installed === 0) return false;
  return (localeFlags & installed) === 0;
}

/// A `*.lowend.sprite` low-quality variant (its high-quality `.sprite` exists too).
export function isLowend(name: string): boolean {
  return name.toLowerCase().includes(".lowend.");
}
