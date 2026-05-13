// Helpers around URLs / origins / intent hashing.
// Origin is the cache key for everything per-app. Intent hash is the cache
// key for "which selector solved this task" lookups.

import { createHash } from "node:crypto";

export function originOf(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const u = new URL(url);
    if (u.protocol === "about:" || u.protocol === "chrome:" || u.protocol === "chrome-extension:") {
      return null;
    }
    // Origin = scheme://host[:port]. Drops path, query, fragment, userinfo.
    return u.origin;
  } catch {
    return null;
  }
}

// Stable hash of a free-form intent string. Lower-cases, collapses whitespace,
// strips punctuation that doesn't carry meaning. So "Click the Login button!"
// and "click login button" both hash to the same key — we don't want trivial
// rewordings to miss the cache.
export function intentHash(intent) {
  const norm = String(intent ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

export function normalizeIntent(intent) {
  return String(intent ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}
