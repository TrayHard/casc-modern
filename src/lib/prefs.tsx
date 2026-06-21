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
  const p = prefs ?? DEFAULT_PREFERENCES;
  // Resolve the icon theme keyed on its *value*, not the prefs object identity:
  // getSettings() hands back a fresh object on every save, so without this a
  // change to an icon-irrelevant pref (overscan, JSON limit, …) would churn the
  // theme identity and force every icon consumer + the whole tree to re-decorate.
  const customSig = JSON.stringify(p.custom_icon_themes);
  const iconTheme = useMemo(
    () => resolveTheme(p.icon_theme, p.custom_icon_themes),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.icon_theme, customSig]
  );
  const value = useMemo<PrefsValue>(
    () => ({ prefs: p, installedLocales, iconTheme }),
    [p, installedLocales, iconTheme]
  );
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
