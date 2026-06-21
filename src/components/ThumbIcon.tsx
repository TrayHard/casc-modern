import { memo, useEffect, useState } from "react";
import { api } from "../lib/api";
import { iconFromTheme } from "../lib/fileIcons";
import { usePrefs } from "../lib/prefs";

// Display box in the tree (px) and the size we ask the backend to decode to.
const THUMB_PX = 22;
const THUMB_DECODE = 32;
// Don't thumbnail huge atlases/textures — decoding them just to shrink to 22px
// isn't worth the cost. Above this the format icon is shown instead.
const MAX_BYTES = 4 * 1024 * 1024;

const THUMBABLE = new Set(["sprite", "dc6", "tga", "bmp", "png", "jpg", "jpeg"]);

// path -> data URL, or `null` for "tried and failed / skipped" (no retry).
// Module-level so the cache survives node remounts during virtual scroll.
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

// Cap concurrent decodes so scrolling a large folder doesn't flood the backend.
const MAX_CONCURRENT = 4;
let active = 0;
const waiting: Array<() => void> = [];
function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiting.push(() => {
      active += 1;
      resolve();
    });
  });
}
function release(): void {
  active -= 1;
  waiting.shift()?.();
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

// Live demand per path: how many mounted ThumbIcons still want it. A decode that
// reaches the front of the queue only to find its path no longer wanted bails,
// so abandoned requests from a fast scroll don't block the rows now on screen.
const wanted = new Map<string, number>();
function want(path: string): void {
  wanted.set(path, (wanted.get(path) ?? 0) + 1);
}
function unwant(path: string): void {
  const n = (wanted.get(path) ?? 0) - 1;
  if (n <= 0) wanted.delete(path);
  else wanted.set(path, n);
}

async function loadThumb(path: string): Promise<string | null> {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  const existing = inflight.get(path);
  if (existing) return existing;
  const run = (async () => {
    await acquire();
    try {
      // Scrolled out of view while queued? Skip the decode — and DON'T cache a
      // miss, so it retries if it scrolls back in.
      if (!wanted.has(path)) return null;
      const b64 = await api.thumbnail(path, THUMB_DECODE);
      const url = `data:image/png;base64,${b64}`;
      cache.set(path, url);
      return url;
    } catch {
      cache.set(path, null); // genuine failure: don't retry this session
      return null;
    } finally {
      release();
      inflight.delete(path);
    }
  })();
  inflight.set(path, run);
  return run;
}

interface Props {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  /** Which thumbnails-* preference gates previews here. */
  where: "tree" | "browser";
}

/// Lazily-decoded mini preview for image-like files, falling back to the
/// themed format/folder icon (while loading, when disabled, too large, or on
/// error).
export const ThumbIcon = memo(function ThumbIcon({
  name,
  path,
  isDir,
  size,
  where,
}: Props) {
  const { prefs, iconTheme } = usePrefs();
  const thumbsOn =
    where === "tree" ? prefs.thumbnails_in_tree : prefs.thumbnails_in_browser;
  const thumbable =
    thumbsOn &&
    !isDir &&
    THUMBABLE.has(extOf(name)) &&
    size > 0 &&
    size <= MAX_BYTES;
  const [url, setUrl] = useState<string | null>(() =>
    thumbable ? cache.get(path) ?? null : null
  );

  useEffect(() => {
    if (!thumbable) return;
    const cached = cache.get(path);
    if (cached !== undefined) {
      setUrl(cached);
      return;
    }
    want(path);
    let cancelled = false;
    loadThumb(path).then((u) => {
      if (!cancelled) setUrl(u);
    });
    return () => {
      cancelled = true;
      unwant(path);
    };
  }, [thumbable, path]);

  if (thumbable && url) {
    return (
      <img
        src={url}
        width={THUMB_PX}
        height={THUMB_PX}
        alt=""
        style={{
          objectFit: "contain",
          verticalAlign: "middle",
          imageRendering: "pixelated",
          background: "rgba(255,255,255,0.04)",
          borderRadius: 2,
        }}
      />
    );
  }
  return <>{iconFromTheme(iconTheme, name, isDir)}</>;
});
