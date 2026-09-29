const fs = require("fs")
const path = require("path")

// Adds an explicit theme choice: System / Light / Dark.
//
// The app already computed `isDark` at render time in every screen
// (`useColorScheme()` → `isDark ? A : B`), so a preference is only a matter of
// feeding those calls from somewhere else. Rather than rewrite 13 call sites,
// this points the *import* at a shim — a one-line change per file — so the whole
// app follows the stored preference while a fresh install keeps following the
// system.
//
// The setting lives in the existing SecureStore-backed settings store, so it
// survives reinstall only in the same way the rest of the settings do.

const TARGET = process.argv[2]
if (!TARGET) {
  console.error("usage: node patch-theme.js <repo-root>")
  process.exit(1)
}

const SHIM = `import { useColorScheme as useSystemColorScheme } from "react-native"
import { useSettings } from "../stores/settings"

/**
 * Colour scheme honouring the user's preference, falling back to the system.
 *
 * Every screen already derives its styles from \`useColorScheme()\`, so
 * repointing that import here is what makes a manual choice apply everywhere
 * without touching a single screen body.
 */
export function useAppColorScheme(): "light" | "dark" | null {
  const preference = useSettings((state) => state.theme)
  const system = useSystemColorScheme()
  if (preference === "light") return "light"
  if (preference === "dark") return "dark"
  return system ?? null
}
`

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

// --- new: src/lib/theme.ts ---------------------------------------------------

const shimFile = path.join(TARGET, "src", "lib", "theme.ts")
if (fs.existsSync(shimFile)) {
  console.error("patch-theme: refusing to overwrite existing src/lib/theme.ts")
  process.exit(1)
}
fs.writeFileSync(shimFile, SHIM)
console.log("src/lib/theme.ts: useAppColorScheme shim")

// --- src/stores/settings.ts: persist the preference ---------------------------

const storeRel = "src/stores/settings.ts"
let store = read(storeRel)

store = replaceOnce(
  store,
  `interface Settings {
  pageSize: number
  notifications: Record<Category, boolean>
  locale: LocalePreference
}`,
  `export type ThemePreference = "system" | "light" | "dark"

interface Settings {
  pageSize: number
  notifications: Record<Category, boolean>
  locale: LocalePreference
  theme: ThemePreference
}`,
  "Settings interface",
  storeRel,
)

store = replaceOnce(
  store,
  `const DEFAULTS: Settings = {
  pageSize: 25,
  notifications: { ...defaultPreferences },
  locale: "system",
}`,
  `const DEFAULTS: Settings = {
  pageSize: 25,
  notifications: { ...defaultPreferences },
  locale: "system",
  theme: "system",
}`,
  "DEFAULTS",
  storeRel,
)

store = replaceOnce(
  store,
  "  setLocale: (locale: LocalePreference) => Promise<void>\n}",
  "  setLocale: (locale: LocalePreference) => Promise<void>\n  setTheme: (theme: ThemePreference) => Promise<void>\n}",
  "SettingsState interface",
  storeRel,
)

store = replaceOnce(
  store,
  "function snapshot(get: () => SettingsState): Settings {\n  return { pageSize: get().pageSize, notifications: get().notifications, locale: get().locale }\n}",
  "function snapshot(get: () => SettingsState): Settings {\n  return {\n    pageSize: get().pageSize,\n    notifications: get().notifications,\n    locale: get().locale,\n    theme: get().theme,\n  }\n}",
  "snapshot",
  storeRel,
)

store = replaceOnce(
  store,
  `  setLocale: async (locale) => {
    set({ locale })
    setAppLocale(locale) // applies immediately
    await persist({ ...snapshot(get), locale })
  },`,
  `  setLocale: async (locale) => {
    set({ locale })
    setAppLocale(locale) // applies immediately
    await persist({ ...snapshot(get), locale })
  },

  setTheme: async (theme) => {
    set({ theme })
    await persist({ ...snapshot(get), theme })
  },`,
  "setTheme action",
  storeRel,
)

save(storeRel, store)
console.log(storeRel + ": theme preference persisted")

// --- repoint useColorScheme at the shim ---------------------------------------

const CONSUMERS = [
  "app/_layout.tsx",
  "app/demo.tsx",
  "app/(tabs)/_layout.tsx",
  "app/(tabs)/connections.tsx",
  "app/(tabs)/index.tsx",
  "app/(tabs)/settings.tsx",
  "app/connection/add.tsx",
  "app/connection/[id].tsx",
  "app/session/[id].tsx",
  "src/components/AuthGate.tsx",
  "src/components/TelemetryConsentModal.tsx",
  "src/components/markdown/Markdown.tsx",
  "src/components/markdown/CodeBlock.tsx",
]

for (const rel of CONSUMERS) {
  let src = read(rel)
  if (src.includes("useAppColorScheme")) continue

  // Relative path to src/lib/theme from the file's own directory.
  const depth = path.dirname(rel).split("/").filter(Boolean).length
  const toRoot = depth === 0 ? "." : Array(depth).fill("..").join("/")
  const shimPath = `${toRoot}/src/lib/theme`

  let changed = false

  // Shape A: the import is a single line, e.g.
  //   import { useColorScheme, View, Text } from "react-native"
  const single = /import \{([^}]*)\} from "react-native"\n/
  const singleMatch = src.match(single)
  if (singleMatch) {
    const names = singleMatch[1]
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean)
    if (!names.includes("useColorScheme")) {
      console.error(rel + " patch FAILED: useColorScheme not in the react-native import")
      process.exit(1)
    }
    const kept = names.filter((n) => n !== "useColorScheme")
    const replacement = kept.length ? `import { ${kept.join(", ")} } from "react-native"\n` : ""
    src = src.replace(single, replacement)
    src = src.replace(
      /^(import .*\n)/m,
      `import { useAppColorScheme as useColorScheme } from "${shimPath}"\n$1`,
    )
    changed = true
  } else {
    // Shape B: multi-line import list — drop the useColorScheme line, then add
    // the shim import right after the closing of the react-native import.
    const line = /\n  useColorScheme,/
    if (!line.test(src)) {
      console.error(rel + " patch FAILED: could not find useColorScheme import")
      process.exit(1)
    }
    src = src.replace(line, "")
    const end = src.indexOf('from "react-native"')
    if (end === -1) {
      console.error(rel + " patch FAILED: no react-native import")
      process.exit(1)
    }
    const insertAt = src.indexOf("\n", end) + 1
    src =
      src.slice(0, insertAt) +
      `import { useAppColorScheme as useColorScheme } from "${shimPath}"\n` +
      src.slice(insertAt)
    changed = true
  }

  if (!changed || !src.includes("useAppColorScheme")) {
    console.error(rel + " patch FAILED: shim import not applied")
    process.exit(1)
  }
  save(rel, src)
}
console.log(CONSUMERS.length + " screens now read the theme preference")

// --- settings.tsx: the picker row --------------------------------------------

const settingsRel = "app/(tabs)/settings.tsx"
let settings = read(settingsRel)

const actionSheet = path.join(TARGET, "src", "components", "ActionSheet.tsx")
if (!fs.existsSync(actionSheet)) {
  console.error("patch-theme: src/components/ActionSheet.tsx is missing — apply patch-archive.js first")
  process.exit(1)
}

settings = replaceOnce(
  settings,
  'import { useSettings } from "../../src/stores/settings"',
  'import { useSettings } from "../../src/stores/settings"\n' +
    'import { ActionSheet } from "../../src/components/ActionSheet"',
  "ActionSheet import",
  settingsRel,
)

settings = replaceOnce(
  settings,
  "  const { notifications, setNotification, locale, setLocale } = useSettings()",
  "  const { notifications, setNotification, locale, setLocale, theme, setTheme } = useSettings()\n" +
    "  const [themeSheetVisible, setThemeSheetVisible] = useState(false)",
  "settings destructure",
  settingsRel,
)

// Appearance sits above "About", next to the language row it complements.
settings = replaceOnce(
  settings,
  '      <SettingSection title={t("settings.sections.about")} isDark={isDark}>',
  `      <SettingSection title={t("settings.sections.appearance")} isDark={isDark}>
        <SettingRow
          icon={theme === "system" ? "phone-portrait-outline" : theme === "dark" ? "moon-outline" : "sunny-outline"}
          label={t("settings.theme.label")}
          description={t("settings.theme.description")}
          isDark={isDark}
          onPress={() => setThemeSheetVisible(true)}
          right={
            <Text style={[styles.themeValue, isDark && styles.metaDark]}>
              {t(
                theme === "system"
                  ? "settings.theme.system"
                  : theme === "dark"
                    ? "settings.theme.dark"
                    : "settings.theme.light",
              )}
            </Text>
          }
        />
      </SettingSection>

      <SettingSection title={t("settings.sections.about")} isDark={isDark}>`,
  "appearance section",
  settingsRel,
)

// The sheet itself, alongside the language picker's Modal.
settings = replaceOnce(
  settings,
  "    </ScrollView>\n  )\n}",
  `      <ActionSheet
        visible={themeSheetVisible}
        title={t("settings.theme.label")}
        cancelLabel={t("common.cancel")}
        isDark={isDark}
        onClose={() => setThemeSheetVisible(false)}
        actions={[
          {
            label: t("settings.theme.system"),
            icon: "phone-portrait-outline",
            onPress: () => void setTheme("system"),
          },
          {
            label: t("settings.theme.light"),
            icon: "sunny-outline",
            onPress: () => void setTheme("light"),
          },
          {
            label: t("settings.theme.dark"),
            icon: "moon-outline",
            onPress: () => void setTheme("dark"),
          },
        ]}
      />
    </ScrollView>
  )
}`,
  "scrollview close",
  settingsRel,
)

// Anchored on footerText with a wildcard colour: patch-settings.js has already
// appended the language-modal styles after this block, and patch-palette.js has
// rewritten its colour, so neither the following "})" nor a specific hex is a
// stable marker.
const footerRe = /(  footerText: \{\n    fontSize: 13,\n    color: "#[0-9a-fA-F]{3,8}",\n    textAlign: "center",\n  \},\n)/
if (!footerRe.test(settings)) {
  console.error(settingsRel + " patch FAILED: footerText style not found")
  process.exit(1)
}
settings = settings.replace(footerRe, `$1  themeValue: {
    fontSize: 14,
    color: "#6b7280",
  },
`)

save(settingsRel, settings)
console.log(settingsRel + ": theme picker")

// --- i18n ---------------------------------------------------------------------

const STRINGS = {
  en: {
    section: "Appearance",
    label: "Theme",
    description: "Follow the system, or force light or dark",
    system: "System",
    light: "Light",
    dark: "Dark",
  },
  ru: {
    section: "Оформление",
    label: "Тема",
    description: "Как в системе, либо всегда светлая или тёмная",
    system: "Как в системе",
    light: "Светлая",
    dark: "Тёмная",
  },
}

for (const [file, s] of [
  ["en.json", STRINGS.en],
  ["zh-Hans.json", STRINGS.en],
]) {
  const rel = path.join("src", "lib", "i18n", file)
  const p = path.join(TARGET, rel)
  const json = JSON.parse(fs.readFileSync(p, "utf8"))
  if (json.settings.theme) continue
  json.settings.sections.appearance = s.section
  json.settings.theme = {
    label: s.label,
    description: s.description,
    system: s.system,
    light: s.light,
    dark: s.dark,
  }
  fs.writeFileSync(p, JSON.stringify(json, null, 2) + "\n")
  console.log(rel + ": settings.theme added")
}
