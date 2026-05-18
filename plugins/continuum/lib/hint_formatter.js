// Shared formatter for popup-hint messages. Used by every hook that drains
// the broker inbox (pre_tool_use, stop, user_prompt_submit).
//
// Responsibilities:
//   - Decode any base64 screenshot data URI into a file under
//     .continuum/screenshots/, capped at SCREENSHOT_KEEP files
//   - Format viewport, picked-element, errors, and screenshot reference
//     into a single markdown block suitable for additionalContext / reason

import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.js";

const SCREENSHOT_KEEP = 50;

export function saveScreenshotIfPresent(projectDir, sessionId, ctx) {
  const shot = ctx?.screenshot;
  if (!shot || typeof shot.dataUri !== "string" || !shot.dataUri.startsWith("data:image/")) return null;
  try {
    const p = paths(projectDir);
    fs.mkdirSync(p.screenshotsDir, { recursive: true });
    try {
      const files = fs.readdirSync(p.screenshotsDir)
        .filter((f) => /\.(png|jpg|webp)$/i.test(f))
        .map((f) => ({ f, t: fs.statSync(path.join(p.screenshotsDir, f)).mtimeMs }))
        .sort((a, b) => a.t - b.t);
      while (files.length >= SCREENSHOT_KEEP) {
        const oldest = files.shift();
        try { fs.unlinkSync(path.join(p.screenshotsDir, oldest.f)); } catch {}
      }
    } catch {}
    const m = shot.dataUri.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
    if (!m) return null;
    const ext = m[1] === "jpeg" ? "jpg" : m[1];
    const safeSession = String(sessionId || "anon").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 24);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const fname = `${safeSession}-${ts}.${ext}`;
    const full = path.join(p.screenshotsDir, fname);
    fs.writeFileSync(full, Buffer.from(m[2], "base64"));
    return { absPath: full, relPath: path.relative(projectDir, full), scope: shot.scope, rect: shot.rect, format: m[1] };
  } catch (e) {
    process.stderr.write(`[continuum:screenshot] save failed: ${e?.message ?? e}\n`);
    return null;
  }
}

export function formatHints(messages, projectDir, sessionId, opts = {}) {
  const { headerLabel = "Mochi" } = opts;
  const lines = [];
  lines.push(`**${headerLabel}**`);
  lines.push("");
  for (const m of messages) {
    lines.push(`> ${m.message || "(empty message)"}`);
    const ctx = m.context || {};
    const bits = [];
    if (ctx.url)       bits.push(`url: \`${ctx.url}\``);
    if (ctx.title)     bits.push(`title: "${ctx.title}"`);
    if (bits.length)   lines.push(`> _${bits.join(" · ")}_`);
    const vp = ctx.viewport;
    if (vp && typeof vp === "object") {
      const dprSuffix = vp.devicePixelRatio && vp.devicePixelRatio !== 1 ? ` @${vp.devicePixelRatio}x` : "";
      const scrollSuffix = (vp.scrollY || vp.scrollX) ? ` · scroll (${vp.scrollX||0},${vp.scrollY||0})` : "";
      const heightHint = vp.scrollHeight && vp.scrollHeight > vp.innerHeight ? ` · page ${vp.scrollWidth || "?"}×${vp.scrollHeight}` : "";
      lines.push(`> _viewport: ${vp.innerWidth}×${vp.innerHeight}${dprSuffix}${scrollSuffix}${heightHint}_`);
    } else if (typeof ctx.viewport === "string") {
      lines.push(`> _viewport: ${ctx.viewport}_`);
    }
    if (Array.isArray(ctx.recentErrors) && ctx.recentErrors.length) {
      lines.push(`> _recent console errors:_`);
      for (const e of ctx.recentErrors.slice(0, 5)) lines.push(`>   • \`${String(e).replace(/`/g, "'")}\``);
    }
    // Inline-reference array — preferred new shape. Each [#N] marker in the
    // message above resolves to the corresponding entry here.
    const picks = Array.isArray(ctx.pickedElements) ? ctx.pickedElements : null;
    if (picks && picks.length) {
      lines.push(`> _elements referenced inline:_`);
      picks.forEach((el, i) => {
        const n = i + 1;
        lines.push(`>   **[#${n}]**`);
        if (el.selector)  lines.push(`>     selector: \`${String(el.selector).replace(/`/g, "'")}\``);
        if (el.tagName)   lines.push(`>     tag: \`<${el.tagName}>\``);
        if (el.rect)      lines.push(`>     rect: ${Math.round(el.rect.width)}×${Math.round(el.rect.height)} @ (${Math.round(el.rect.x)},${Math.round(el.rect.y)})`);
        if (el.text)      lines.push(`>     text: "${String(el.text).slice(0, 120).replace(/"/g, "'")}${el.text.length > 120 ? "…" : ""}"`);
        if (el.outerHTML) {
          const snippet = String(el.outerHTML).slice(0, 300).replace(/\n/g, " ").replace(/`/g, "'");
          lines.push(`>     outerHTML: \`${snippet}${el.outerHTML.length > 300 ? "…" : ""}\``);
        }
      });
    } else {
      // Legacy single pickedElement path.
      const el = ctx.pickedElement;
      if (el && (el.selector || el.outerHTML)) {
        lines.push(`> _user picked DOM element:_`);
        if (el.selector)  lines.push(`>   • selector: \`${String(el.selector).replace(/`/g, "'")}\``);
        if (el.tagName)   lines.push(`>   • tag: \`<${el.tagName}>\``);
        if (el.rect)      lines.push(`>   • rect: ${Math.round(el.rect.width)}×${Math.round(el.rect.height)} @ (${Math.round(el.rect.x)},${Math.round(el.rect.y)})`);
        if (el.text)      lines.push(`>   • text: "${String(el.text).slice(0, 120).replace(/"/g, "'")}${el.text.length > 120 ? "…" : ""}"`);
        if (el.outerHTML) {
          const snippet = String(el.outerHTML).slice(0, 400).replace(/\n/g, " ").replace(/`/g, "'");
          lines.push(`>   • outerHTML: \`${snippet}${el.outerHTML.length > 400 ? "…" : ""}\``);
        }
      }
    }
    const saved = saveScreenshotIfPresent(projectDir, sessionId, ctx);
    if (saved) {
      const dims = saved.rect ? `${Math.round(saved.rect.width)}×${Math.round(saved.rect.height)}` : "viewport";
      lines.push(`> _screenshot:_ \`${saved.relPath}\` (${dims}, scope=${saved.scope || "?"}) — use \`Read("${saved.relPath}")\` to view it.`);
    }
    lines.push(`> _sent ${m.ts}_`);
    lines.push("");
  }
  lines.push("React to the hint(s) in your next reply or action. They have already been removed from the inbox.");
  return lines.join("\n");
}
