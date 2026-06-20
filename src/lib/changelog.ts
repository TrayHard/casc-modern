/// Parsing for the project CHANGELOG, used by the updater to tell the user
/// what's new and how far behind they are. The release tooling embeds the
/// changelog text into the updater manifest's `notes`, so `pending.body`
/// arrives here as Keep-a-Changelog markdown.

export type ChangelogEntry = {
  version: string;
  date: string | null;
  /// Raw markdown body for the version (without the heading line).
  body: string;
};

const HEADING = /^##\s+\[?v?(\d+\.\d+\.\d+)\]?(?:\s*[-–—]\s*(.+?))?\s*$/;

/// Split Keep-a-Changelog markdown into per-version entries, in document order
/// (newest first by convention). Lines before the first version heading and
/// link-reference footers are ignored.
export function parseChangelog(md: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let cur: ChangelogEntry | null = null;
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(HEADING);
    if (m) {
      if (cur) entries.push(cur);
      cur = { version: m[1], date: (m[2] ?? "").trim() || null, body: "" };
    } else if (cur) {
      cur.body += line + "\n";
    }
  }
  if (cur) entries.push(cur);
  return entries.map((e) => ({ ...e, body: e.body.trim() }));
}

/// Compare dotted numeric versions. >0 if a>b, <0 if a<b, 0 if equal.
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/// Entries strictly newer than `current`, sorted newest first.
export function entriesNewerThan(
  entries: ChangelogEntry[],
  current: string
): ChangelogEntry[] {
  return entries
    .filter((e) => compareSemver(e.version, current) > 0)
    .sort((a, b) => compareSemver(b.version, a.version));
}
