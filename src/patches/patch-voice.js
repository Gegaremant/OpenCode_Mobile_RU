const fs = require("fs")
const path = require("path")

// Makes dictation fast (and explains the engine).
//
// Which engine is it? expo-speech-recognition talks to Android's own
// SpeechRecognizer, which binds to the *default* recognition service — on any
// device with Play services that is Google's, i.e. the very engine behind
// Gboard's voice typing. So "use Gboard" is not a different API: it is (a) naming
// Google's service explicitly so a third-party default can't take over, and
// (b) making sure the Russian model is used off-device instead of round-tripping
// every partial through the network.
//
// What was slow: start() passed neither `androidRecognitionServicePackage` nor
// `requiresOnDeviceRecognition`, so recognition used whatever default service
// the device had, sent the audio to the server, and returned no punctuation and
// no context — the recognizer had to guess at code words, which is where the
// perceived "slowness" (long silences, wrong guesses) comes from.
//
// What this does, in order, at press time:
//   1. pick Google's speech service if it is installed (falling back to the
//      device default, then to no package at all);
//   2. ask that service which locales are installed OFFLINE and, if ru-RU (or
//      the current UI language) is among them, run fully on-device — no network
//      round trip per partial, and the audio never leaves the phone;
//   3. turn on punctuation (Android 13+) and hand the recognizer the words
//      already in the composer plus the session title as biasing phrases, which
//      is the single biggest accuracy win for code-related dictation.
//
// Both probes are cached: getSupportedLocales() hits the recognition service,
// and it is not something to repeat on every tap.

const TARGET = process.argv[2]
if (!TARGET) {
  console.error("usage: node patch-voice.js <repo-root>")
  process.exit(1)
}

const GOOGLE_RECOGNITION_SERVICE = "com.google.android.as"

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

// --- src/lib/speech.ts -------------------------------------------------------

const rel = "src/lib/speech.ts"
let src = read(rel)

src = replaceOnce(
  src,
  'import i18n from "./i18n/config"',
  'import i18n from "./i18n/config"\n' +
    'import { Platform } from "react-native"',
  "i18n import",
  rel,
)

src = replaceOnce(
  src,
  `interface SpeechActions {`,
  `/** Words handed to the recogniser as hints, so it stops guessing at code. */
export interface SpeechHints {
  draft?: string
  context?: string
}

/**
 * Cached engine capabilities. Resolving these costs a call into the
 * recognition service, so it happens once per process, not once per tap.
 */
const GOOGLE_RECOGNITION_SERVICE = "com.google.android.as"

let enginePromise: Promise<SpeechEngine> | null = null

interface SpeechEngine {
  /** Google's service when installed, otherwise undefined (device default). */
  servicePackage?: string
  /** Locales with a downloaded on-device model for that service. */
  offlineLocales: string[]
}

function engine(): Promise<SpeechEngine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      if (Platform.OS !== "android") return { offlineLocales: [] }
      try {
        const installed = ExpoSpeechRecognitionModule.getSpeechRecognitionServices()
        const servicePackage = installed.includes(GOOGLE_RECOGNITION_SERVICE)
          ? GOOGLE_RECOGNITION_SERVICE
          : undefined
        // The options object is required, not optional, in the module's types.
        const { installedLocales } = await ExpoSpeechRecognitionModule.getSupportedLocales(
          servicePackage ? { androidRecognitionServicePackage: servicePackage } : {},
        )
        return { servicePackage, offlineLocales: installedLocales || [] }
      } catch {
        // Older service packages (or none) may throw "package_not_found" —
        // recognition still works, just not off-device.
        return { offlineLocales: [] }
      }
    })()
  }
  return enginePromise
}

/** True when the model for this language is downloaded, so audio can stay local. */
export function hasOfflineModel(lang: string): Promise<boolean> {
  return engine().then(({ offlineLocales }) =>
    offlineLocales.some((locale) => locale.toLowerCase().startsWith(lang.split("-")[0].toLowerCase())),
  )
}

interface SpeechActions {`,
  "engine probe",
  rel,
)

src = replaceOnce(
  src,
  `  const start = useCallback(async () => {
    // Dictate in the language of the UI: the en-US model mangles Russian.
    const lang = i18n.language?.startsWith("ru") ? "ru-RU" : "en-US"`,
  `  const start = useCallback(async () => {
    // Dictate in the language of the UI: the en-US model mangles Russian.
    const lang = i18n.language?.startsWith("ru") ? "ru-RU" : "en-US"
    const { servicePackage } = await engine()`,
  "start lang",
  rel,
)

src = replaceOnce(
  src,
  `    setError(null)
    setPermissionDenied(false)
    ExpoSpeechRecognitionModule.start({
      lang,
      interimResults: true,
      continuous: true,
    })
  }, [t])`,
  `    setError(null)
    setPermissionDenied(false)

    // Only promise offline recognition when the model is actually installed —
    // requiresOnDeviceRecognition makes the recogniser fail outright otherwise.
    const onDevice = await hasOfflineModel(lang)

    // Biasing phrases: the recogniser already hears the composer, so the words
    // in it (and the session title) become far better guesses than a blank
    // vocabulary. Capped because the intent extra is a string list, not a corpus.
    const contextualStrings = [hints?.draft, hints?.context]
      .map((value) => (value || "").replace(/\\s+/g, " ").trim())
      .filter(Boolean)
      .map((value) => value.slice(0, 200))
      .slice(0, 2)

    ExpoSpeechRecognitionModule.start({
      lang,
      interimResults: true,
      continuous: true,
      ...(servicePackage ? { androidRecognitionServicePackage: servicePackage } : null),
      ...(onDevice ? { requiresOnDeviceRecognition: true } : null),
      // Android 13+ only; ignored by the platform on older releases.
      ...(Platform.OS === "android" ? { addsPunctuation: true } : null),
      ...(contextualStrings.length > 0 ? { contextualStrings } : null),
    })
  }, [t, hints])`,
  "start options",
  rel,
)

src = replaceOnce(
  src,
  "export function useSpeech(onResult: (text: string) => void): SpeechState & SpeechActions {",
  "export function useSpeech(onResult: (text: string) => void, hints?: SpeechHints): SpeechState & SpeechActions {",
  "useSpeech signature",
  rel,
)

save(rel, src)
console.log(rel + ": Google engine pinned, on-device model preferred, biasing hints sent")

// --- app/session/[id].tsx: pass the composer + title as hints ----------------

const screenRel = "app/session/[id].tsx"
let screen = read(screenRel)

screen = replaceOnce(
  screen,
  `  const speech = useSpeech(
    useCallback((text: string) => {
      setInput((prev) => (prev ? prev + " " + text : text))
    }, []),
  )`,
  `  // Hints: what's already typed and what the chat is called, so the
  // recogniser prefers the words that actually belong in this conversation.
  const speech = useSpeech(
    useCallback((text: string) => {
      setInput((prev) => (prev ? prev + " " + text : text))
    }, []),
    { draft: input, context: currentSession?.title },
  )`,
  "useSpeech hints",
  screenRel,
)

save(screenRel, screen)
console.log(screenRel + ": composer text and session title feed the recogniser")
