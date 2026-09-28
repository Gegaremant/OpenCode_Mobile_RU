const fs = require("fs")
const path = require("path")

// Makes voice input usable (and its failures legible) on Android.
//
// What actually went wrong before:
//   * expo-speech-recognition's native `start()` refuses to record without
//     RECORD_AUDIO and reports it as `error: "not-allowed"`,
//     `message: "Missing RECORD_AUDIO permissions."`. The app stored that raw
//     English string and popped it under a generic title — from the user's side
//     that is just "voice input says I lack permissions", with no way forward
//     once Android stops showing the system dialog.
//   * Recognition was pinned to `lang: "en-US"`, so dictating Russian through
//     the Russian UI produced garbage.
//   * `isRecognitionAvailable()` was never consulted, so a device without a
//     recognition service silently did nothing.
//
// This patch localises + classifies the errors (with an "open app settings"
// escape hatch for a refused mic), recognises in the UI language, and probes
// availability. RECORD_AUDIO itself is guaranteed by the workflow step that
// runs after `expo prebuild`.

const TARGET = process.argv[2]
if (!TARGET) {
  console.error("usage: node patch-speech.js <repo-root>")
  process.exit(1)
}

function read(rel) {
  const p = path.join(TARGET, rel)
  if (!fs.existsSync(p)) {
    console.error("not found: " + p)
    process.exit(1)
  }
  return fs.readFileSync(p, "utf8")
}

function write(rel, src) {
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

const speechRel = "src/lib/speech.ts"
let speech = read(speechRel)

speech = replaceOnce(
  speech,
  'import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition"\n',
  'import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition"\n' +
    'import { useTranslation } from "react-i18next"\n' +
    'import i18n from "./i18n/config"\n',
  "imports",
  speechRel,
)

speech = replaceOnce(
  speech,
  `interface SpeechState {
  listening: boolean
  transcript: string
  error: string | null
}`,
  `interface SpeechState {
  listening: boolean
  transcript: string
  /** Already localized — safe to show as-is. */
  error: string | null
  /**
   * The mic was refused. Once Android has stopped asking, the only way out is
   * the OS app-settings toggle, so the caller offers a shortcut to it.
   */
  permissionDenied: boolean
}`,
  "SpeechState",
  speechRel,
)

speech = replaceOnce(
  speech,
  `  const [error, setError] = useState<string | null>(null)
  const pending = useRef("")`,
  `  const [error, setError] = useState<string | null>(null)
  const [permissionDenied, setPermissionDenied] = useState(false)
  const { t } = useTranslation()
  const pending = useRef("")`,
  "state",
  speechRel,
)

speech = replaceOnce(
  speech,
  `  useSpeechRecognitionEvent("error", (event) => {
    // "no-speech" is not really an error — user just didn't say anything
    if (event.error === "no-speech") {
      setListening(false)
      return
    }
    setError(event.message || event.error)
    setListening(false)
  })`,
  `  useSpeechRecognitionEvent("error", (event) => {
    // "no-speech" is not really an error — user just didn't say anything. Nor is
    // "aborted", which the native module emits for our own abort() on unmount.
    if (event.error === "no-speech" || event.error === "aborted") {
      setListening(false)
      return
    }
    // "not-allowed" is what the native side reports when RECORD_AUDIO is
    // missing or was refused — the one case the user can still act on.
    if (event.error === "not-allowed") {
      setError(t("chat.speechErrors.permissionDenied"))
      setPermissionDenied(true)
      setListening(false)
      return
    }
    setError(event.message || event.error)
    setPermissionDenied(false)
    setListening(false)
  })`,
  "error handler",
  speechRel,
)

speech = replaceOnce(
  speech,
  `  const start = useCallback(async () => {
    const result = await ExpoSpeechRecognitionModule.requestPermissionsAsync()
    if (!result.granted) {
      setError("Microphone permission denied")
      return
    }
    ExpoSpeechRecognitionModule.start({
      lang: "en-US",
      interimResults: true,
      continuous: true,
    })
  }, [])`,
  `  const start = useCallback(async () => {
    // Dictate in the language of the UI: the en-US model mangles Russian.
    const lang = i18n.language?.startsWith("ru") ? "ru-RU" : "en-US"

    // No recognition service on the device (or not on the emulator image).
    // Checked before asking for the mic so we don't prompt for nothing.
    if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
      setError(t("chat.speechErrors.unavailable"))
      return
    }

    let granted = false
    try {
      const result = await ExpoSpeechRecognitionModule.requestPermissionsAsync()
      granted = !!result.granted
    } catch {
      // The permission manager can throw outright when the manifest lost
      // RECORD_AUDIO — treat it exactly like a refusal.
      granted = false
    }
    if (!granted) {
      setError(t("chat.speechErrors.permissionDenied"))
      setPermissionDenied(true)
      return
    }

    setError(null)
    setPermissionDenied(false)
    ExpoSpeechRecognitionModule.start({
      lang,
      interimResults: true,
      continuous: true,
    })
  }, [t])`,
  "start()",
  speechRel,
)

speech = replaceOnce(
  speech,
  "  return { listening, transcript, error, start, stop, cancel }",
  "  return { listening, transcript, error, permissionDenied, start, stop, cancel }",
  "return",
  speechRel,
)

write(speechRel, speech)
console.log(speechRel + ": localized errors, UI-language recognition, availability probe")

// --- app/session/[id].tsx ----------------------------------------------------

const sessionRel = "app/session/[id].tsx"
let session = read(sessionRel)

session = replaceOnce(
  session,
  "  ActivityIndicator,\n  Alert,\n} from \"react-native\"",
  "  ActivityIndicator,\n  Alert,\n  Linking,\n  type AlertButton,\n} from \"react-native\"",
  "react-native imports",
  sessionRel,
)

session = replaceOnce(
  session,
  `  useEffect(() => {
    if (!speech.error) return
    Alert.alert(t("session.alerts.speechErrorTitle"), t("session.alerts.speechErrorMessage"))
  }, [speech.error, t])`,
  `  useEffect(() => {
    if (!speech.error) return
    // Report the real reason instead of a generic string, and when the mic was
    // refused hand the user the only thing left: the OS app-settings toggle.
    const buttons: AlertButton[] = speech.permissionDenied
      ? [
          { text: t("common.cancel"), style: "cancel" },
          { text: t("chat.speechErrors.openSettings"), onPress: () => void Linking.openSettings() },
        ]
      : [{ text: t("common.ok"), style: "cancel" }]
    Alert.alert(t("session.alerts.speechErrorTitle"), speech.error, buttons)
  }, [speech.error, speech.permissionDenied, t])`,
  "speech error alert",
  sessionRel,
)

write(sessionRel, session)
console.log(sessionRel + ": speech failure now explains itself and can open settings")

// --- app.json: un-block RECORD_AUDIO ----------------------------------------
//
// The actual reason voice input could never work: app.json configures
// expo-image-picker with `"microphonePermission": false`, and that plugin turns
// the `false` into `AndroidConfig.Permissions.withBlockedPermissions([RECORD_AUDIO])`
// (expo-image-picker/plugin/build/withImagePicker.js), i.e. it writes
//
//   <uses-permission android:name="android.permission.RECORD_AUDIO" tools:node="remove"/>
//
// into the app manifest. The merger honours the removal unconditionally, so
// expo-speech-recognition's own `withPermissions([RECORD_AUDIO])` is discarded
// and the release APK ships with no microphone permission at all — verified on
// a locally built 0.4.15: the merged manifest and `aapt2 dump badging` have no
// RECORD_AUDIO, and the module then reports "Missing RECORD_AUDIO permissions.".
//
// Giving image-picker a real description (it never requests the mic itself; only
// speech-to-text does) drops the blocker, so the permission survives. The
// runtime dialog still only appears when the mic is actually used.

const appRel = "app.json"
let appJson = read(appRel)

appJson = replaceOnce(
  appJson,
  '"microphonePermission": false',
  '"microphonePermission": "OpenCode uses the microphone for voice input (speech-to-text) of messages."',
  "expo-image-picker microphonePermission",
  appRel,
)

write(appRel, appJson)
console.log(appRel + ": RECORD_AUDIO is no longer blocked for expo-image-picker")

// --- i18n --------------------------------------------------------------------

// en.json / zh-Hans.json ship upstream and are copied over on every sync, so the
// new keys are injected here (same trick the workflow uses for
// settings.language.ru). ru.json lives in this repo and is edited directly.
const SPEECH_ERRORS = {
  permissionDenied: "Microphone access is not granted. Allow it in the app settings, then try again.",
  unavailable: "Speech recognition is not available on this device.",
  openSettings: "Open settings",
}

for (const file of ["en.json", "zh-Hans.json"]) {
  const rel = path.join("src", "lib", "i18n", file)
  const p = path.join(TARGET, rel)
  if (!fs.existsSync(p)) {
    console.error("not found: " + p)
    process.exit(1)
  }
  const json = JSON.parse(fs.readFileSync(p, "utf8"))
  if (!json.chat) {
    console.error(rel + " patch FAILED: no chat section")
    process.exit(1)
  }
  if (json.chat.speechErrors) continue
  const chat = {}
  for (const [key, value] of Object.entries(json.chat)) {
    chat[key] = value
    if (key === "reasoningBlock") chat.speechErrors = SPEECH_ERRORS
  }
  if (!chat.speechErrors) chat.speechErrors = SPEECH_ERRORS
  json.chat = chat
  fs.writeFileSync(p, JSON.stringify(json, null, 2) + "\n")
  console.log(rel + ": chat.speechErrors added")
}
