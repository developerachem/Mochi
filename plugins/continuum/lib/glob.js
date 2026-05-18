// Tiny zero-dep glob matcher. Handles:
//   *            — any chars within a path segment (not /)
//   **           — any number of path segments
//   ?            — any single char (not /)
//   {a,b,c}      — alternation (no nesting)
//   literal /    — path separator (must be present in both)
//
// Not a full minimatch replacement — sufficient for frontend_globs config
// like "src/**/*.{tsx,jsx,vue,svelte,css}" and "**/*.test.js".

function escapeRe(s) {
  return s.replace(/[.+^$()|[\]\\]/g, "\\$&");
}

function expandAlternation(pattern) {
  // Expand {a,b,c} into [a, b, c] cross-product
  const m = pattern.match(/\{([^{}]+)\}/);
  if (!m) return [pattern];
  const opts = m[1].split(",");
  const head = pattern.slice(0, m.index);
  const tail = pattern.slice(m.index + m[0].length);
  const expanded = [];
  for (const o of opts) {
    for (const t of expandAlternation(head + o + tail)) expanded.push(t);
  }
  return expanded;
}

export function globToRegex(pattern) {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // ** — match any number of path segments (including zero)
        re += "(?:.*?)";
        i += 2;
        // consume an optional following "/"
        if (pattern[i] === "/") i += 1;
      } else {
        // single * — match any chars except /
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += escapeRe(c);
      i += 1;
    }
  }
  re += "$";
  return new RegExp(re);
}

export function matchGlob(path, pattern) {
  const expanded = expandAlternation(pattern);
  for (const p of expanded) {
    const re = globToRegex(p);
    if (re.test(path)) return true;
  }
  return false;
}

export function matchAny(path, patterns) {
  if (!Array.isArray(patterns)) return false;
  for (const p of patterns) {
    if (matchGlob(path, p)) return true;
  }
  return false;
}
