const fs = require("fs")
const path = require("path")

// The app's "about"/"privacy" links pointed at the upstream project, so a user
// of this RU build was sent to someone else's repository and someone else's
// privacy policy — which describes a build that isn't theirs. Repoint them at
// this repository, whose README documents exactly what this build does and what
// it sends nowhere.
//
// Note the upstream link bug this also removes: the GitHub row linked to
// `github.com/anomalyco/opencode` (the CLI/agent project), not even to the
// mobile app the settings screen belongs to.

const TARGET = process.argv[2]
if (!TARGET) {
  console.error("usage: node patch-links.js <repo-root>")
  process.exit(1)
}

const REPO = "https://github.com/Gegaremant/OpenCode_Mobile_RU"
const README = REPO + "/blob/main/README.md"
const PRIVACY = README + "#конфиденциальность-и-данные"
const QUICKSTART = README + "#быстрый-старт"

function read(rel) {
  const p = path.join(TARGET, rel)
  if (!fs.existsSync(p)) {
    console.error("not found: " + p)
    process.exit(1)
  }
  return fs.readFileSync(p, "utf8")
}

function save(rel, src) {
  fs.writeFileSync(path.join(TARGET, rel), src)
}

function replaceOnce(haystack, needle, replacement, label, rel) {
  const idx = haystack.indexOf(needle)
  if (idx === -1) {
    console.error(rel + " patch FAILED: marker not found: " + label)
    process.exit(1)
  }
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length)
}

// --- src/lib/links.ts --------------------------------------------------------

const linksRel = "src/lib/links.ts"
let links = read(linksRel)

links = replaceOnce(
  links,
  'export const PRIVACY_POLICY_URL = "https://dzianisv.github.io/opencode-mobile/privacy/"',
  "// Points at this fork's own README, which documents the actual privacy\n" +
    "// behaviour of this build (no data leaves the device, telemetry is opt-in)\n" +
    '// rather than the upstream project\'s policy page.\n' +
    'export const PRIVACY_POLICY_URL = "' +
    PRIVACY +
    '"',
  "PRIVACY_POLICY_URL",
  linksRel,
)

links = replaceOnce(
  links,
  'export const SETUP_GUIDE_URL = "https://dzianisv.github.io/opencode-mobile/guide/"',
  'export const SETUP_GUIDE_URL = "' + QUICKSTART + '"',
  "SETUP_GUIDE_URL",
  linksRel,
)

save(linksRel, links)
console.log(linksRel + ": privacy + setup guide -> this repository")

// --- app/(tabs)/settings.tsx: the "source code" row --------------------------

const settingsRel = "app/(tabs)/settings.tsx"
let settings = read(settingsRel)

settings = replaceOnce(
  settings,
  'onPress={() => Linking.openURL("https://github.com/anomalyco/opencode")}',
  'onPress={() => Linking.openURL("' + REPO + '")}',
  "github row",
  settingsRel,
)

save(settingsRel, settings)
console.log(settingsRel + ": source code row -> this repository")
