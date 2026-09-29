const fs = require("fs")
const path = require("path")

// Repaints the whole app.
//
// The upstream palette is a hand-picked set of greys that fails contrast in
// places (#999999 on white is 2.8:1, #666666 on #0a0a0a is 3.4:1 — both below
// WCAG AA for body text) and leans hard on a single loud violet (#8b5cf6 /
// #6d28d9) for every accent, link and badge. The result reads as harsh in both
// themes, which is what this pass replaces with one coherent ramp:
//
//   light  surface #ffffff · subtle #f7f8fa · border #e3e6ec
//          text #14181f · secondary #5c6675 · muted #6b7280 · icon #b9c0cc
//   dark   surface #101317 · raised #191e26 · elevated #232a35 · border #2b313b
//          text #f2f4f7 · secondary #a3acbb · muted #8b95a5 · icon #5b6472
//   accent #2563eb (light) / #7aa7f0 (dark) — blue instead of violet, and the
//          same value everywhere instead of a different hue per component
//
// Pairs are remapped first (`isDark ? dark : light`), because both roles are
// known there; then the remaining single literals. Every value below is a role
// that is unambiguous across the codebase — no judgement call per file, which
// is what keeps this reviewable and reversible.
//
// This is a value-only pass: no styles move, no components change, so it stays
// consistent with the app's existing `isDark ? A : B` structure.

const TARGET = process.argv[2]
if (!TARGET) {
  console.error("usage: node patch-palette.js <repo-root>")
  process.exit(1)
}

// [dark, light] -> [newDark, newLight]
const PAIRS = [
  ["#666666", "#999999", "#8b95a5", "#6b7280"],
  ["#888888", "#666666", "#a3acbb", "#5c6675"],
  ["#0a0a0a", "#ffffff", "#101317", "#ffffff"],
  ["#ffffff", "#0a0a0a", "#f2f4f7", "#14181f"],
  ["#8b5cf6", "#6d28d9", "#7aa7f0", "#2563eb"],
  ["#444444", "#cccccc", "#5b6472", "#b9c0cc"],
  ["#666666", "#cccccc", "#8b95a5", "#b9c0cc"],
  ["#7dd3fc", "#0369a1", "#7cc0ff", "#1d4ed8"],
  ["#a1a1aa", "#6b7280", "#9aa3b2", "#5c6675"],
  ["#a78bfa", "#6d28d9", "#7aa7f0", "#2563eb"],
  ["#1a1a1a", "#e5e5e5", "#232a35", "#e3e6ec"],
  ["#e5e5e5", "#0a0a0a", "#e3e6ec", "#14181f"],
  ["#94a3b8", "#64748b", "#9aa3b2", "#566072"],
  ["#555555", "#999999", "#5c6675", "#6b7280"],
  ["#3a3a3a", "#dddddd", "#39414f", "#c2c8d2"],
  ["#c4b5fd", "#6d28d9", "#93c5fd", "#1d4ed8"],
  ["#555555", "#bbbbbb", "#5c6675", "#aab2be"],
  ["#555555", "#cccccc", "#5c6675", "#b9c0cc"],
]

// Single literals, in the order the remaining ones are hit.
const SINGLES = [
  ["#0a0a0a", "#101317"],
  ["#1a1a1a", "#191e26"],
  ["#151515", "#161b22"],
  ["#2a2a2a", "#232a35"],
  ["#3a3a3a", "#39414f"],
  ["#444444", "#5b6472"],
  ["#555555", "#5c6675"],
  ["#666666", "#5c6675"],
  ["#888888", "#a3acbb"],
  ["#999999", "#6b7280"],
  ["#a1a1aa", "#9aa3b2"],
  ["#bbbbbb", "#aab2be"],
  ["#cccccc", "#b9c0cc"],
  ["#dddddd", "#c2c8d2"],
  ["#e5e5e5", "#e3e6ec"],
  ["#f5f5f5", "#f1f3f7"],
  ["#f0f0ff", "#eef4ff"],
  ["#f5f3ff", "#eef4ff"],
  ["#e8e5f0", "#eef1f6"],
  ["#e8e8e8", "#eef1f6"],
  ["#2a2040", "#1b2230"],
  ["#6d28d9", "#2563eb"],
  ["#8b5cf6", "#7aa7f0"],
  ["#a78bfa", "#7aa7f0"],
  ["#c4b5fd", "#93c5fd"],
  ["#c7d2fe", "#bfdbfe"],
  ["#6366f1", "#2563eb"],
  ["#1e1b4b", "#16213a"],
  ["#3730a3", "#1e3a8a"],
  ["#22c55e", "#16a34a"],
  ["#ef4444", "#dc2626"],
  ["#3b82f6", "#2563eb"],
  ["#7dd3fc", "#7cc0ff"],
  ["#0369a1", "#1d4ed8"],
  ["#f59e0b", "#d97706"],
  ["#d4a574", "#a3acbb"],
]

// Second pass: the one-off styles that never used the core ramp — purple-tinted
// dark surfaces, the amber "reasoning" block, off-ramp greys and a handful of
// leftovers from other components. Left alone they would read as a different
// app, which is the exact complaint this pass exists to answer.
const STRAY_SINGLES = [
  // dark surfaces that were tinted violet
  ["#1a1a2e", "#161d2b"],
  ["#1f1a2e", "#161d2b"],
  ["#2a1a3e", "#1b2233"],
  ["#2a1a4a", "#1b2233"],
  ["#1a1030", "#151b26"],
  ["#2a2a3e", "#232a35"],
  ["#0c2b3d", "#16213a"],
  ["#0c4a6e", "#1d3a5c"],
  ["#1e293b", "#1c2230"],
  ["#1a2e1a", "#152015"],
  ["#1a0a0a", "#1c1010"],
  ["#2a0a0a", "#1c1010"],
  // the amber reasoning block -> neutral, keeping the amber bulb icon
  ["#fffbeb", "#f7f8fa"],
  ["#fef3c7", "#e3e6ec"],
  ["#92400e", "#566072"],
  ["#78350f", "#5c6675"],
  ["#1a1a0a", "#101317"],
  ["#1a1800", "#101317"],
  ["#333300", "#232a35"],
  // off-ramp greys
  ["#000", "#14181f"],
  ["#fff", "#ffffff"],
  ["#111", "#101317"],
  ["#111111", "#101317"],
  ["#333", "#39414f"],
  ["#333333", "#39414f"],
  ["#374151", "#39414f"],
  ["#4a4a5a", "#39414f"],
  ["#767577", "#6b7280"],
  ["#a0a0a0", "#8b95a5"],
  ["#aaaaaa", "#a3acbb"],
  ["#888", "#8b95a5"],
  ["#9ca3af", "#8b95a5"],
  ["#94a3b8", "#9aa3b2"],
  ["#64748b", "#566072"],
  ["#f0f0f0", "#f1f3f7"],
  ["#f8f8f8", "#f7f8fa"],
  ["#fafafa", "#f7f8fa"],
  ["#f8fafc", "#f7f8fa"],
  ["#f1f5f9", "#f7f8fa"],
  ["#cdd3da", "#b9c0cc"],
  ["#d1d5db", "#e3e6ec"],
  // remaining violets
  ["#e9d5ff", "#eef4ff"],
  ["#f3e8ff", "#eef4ff"],
  ["#ede9fe", "#eef4ff"],
  ["#7c3aed", "#2563eb"],
  ["#ec4899", "#e11d48"],
  // status ramps
  ["#065f46", "#0d3b2a"],
  ["#052e16", "#0d2416"],
  ["#10b981", "#16a34a"],
  ["#dcfce7", "#e7f6ec"],
  ["#f0fdf4", "#f2fbf4"],
  ["#7f1d1d", "#3f1414"],
  ["#fee2e2", "#fdeaea"],
  ["#e0f2fe", "#e8f1fe"],
  ["#eff6ff", "#eef4ff"],
]

const PAIR_RE = /(isDark|colorScheme === "dark")(\s*\?\s*)"(#[0-9a-fA-F]{3,8})"(\s*:\s*)"(#[0-9a-fA-F]{3,8})"/g

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

const files = walk(path.join(TARGET, "app"), []).concat(walk(path.join(TARGET, "src"), []))
let pairHits = 0
let singleHits = 0
const touched = []

for (const file of files) {
  const before = fs.readFileSync(file, "utf8")
  let after = before

  after = after.replace(PAIR_RE, (match, cond, q1, dark, q2, light) => {
    const hit = PAIRS.find(([d, l]) => d.toLowerCase() === dark.toLowerCase() && l.toLowerCase() === light.toLowerCase())
    if (!hit) return match
    pairHits++
    return `${cond}${q1}"${hit[2]}"${q2}"${hit[3]}"`
  })

  for (const [from, to] of SINGLES.concat(STRAY_SINGLES)) {
    const re = new RegExp(`"${from}"`, "gi")
    const matches = after.match(re)
    if (!matches) continue
    singleHits += matches.length
    after = after.replace(re, `"${to}"`)
  }

  if (after !== before) {
    fs.writeFileSync(file, after)
    touched.push(path.relative(TARGET, file))
  }
}

console.log("patch-palette: " + pairHits + " isDark pairs, " + singleHits + " literals, " + touched.length + " files")
if (pairHits === 0) {
  console.error("patch-palette: no pairs matched — the palette would silently do nothing")
  process.exit(1)
}
