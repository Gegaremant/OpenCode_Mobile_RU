const fs = require("fs")
const path = require("path")

// Stops the on-screen keyboard from covering the bottom of the app.
//
// Why the shipped fix doesn't work: RN reports `endCoordinates.screenY` on
// Android as the bottom of the *visible display frame* whenever softInputMode
// isn't `adjustNothing` (ReactRootView.CustomGlobalLayoutListener computes
// `screenY = mVisibleViewArea.bottom`, i.e. "as if the window had already been
// resized"). KeyboardAvoidingView then evaluates
// `frame.y + frame.height - screenY` and lands on ~0, so
// `behavior="padding"` pads nothing on Android — and since the app is
// edge-to-edge (Expo SDK 54 / Android 15+), `android:windowSoftInputMode=
// adjustResize` no longer resizes the window either, so nothing else moves the
// composer, the toolbar or the form buttons out from under the keyboard.
//
// `endCoordinates.height`, by contrast, comes from the IME inset
// (`imeInsets.bottom - barInsets.bottom`) on Android and from the keyboard frame
// on iOS. Reserving exactly that many dp is correct on both, and it collapses
// to 0 on the platforms where the OS already avoids the keyboard for us.
//
// This patch therefore:
//   1. adds src/lib/keyboard-inset.ts (the useKeyboardInset hook),
//   2. swaps the session screen's no-op KeyboardAvoidingView for a plain View
//      padded by the hook,
//   3. gives the two connection forms (which never had any avoidance at all)
//      a content inset so their last field/button can clear the keyboard.

const TARGET = process.argv[2]
if (!TARGET) {
  console.error("usage: node patch-keyboard.js <repo-root>")
  process.exit(1)
}

const HOOK = `import { useEffect, useState } from "react"
import { Keyboard, Platform, type KeyboardEvent } from "react-native"

/**
 * Height (dp) the on-screen keyboard takes over the bottom of the window, or 0
 * while it is closed.
 *
 * Not KeyboardAvoidingView: on Android RN reports \`endCoordinates.screenY\` as
 * the bottom of the visible display frame whenever softInputMode isn't
 * \`adjustNothing\` — i.e. as if the window had already been resized for the
 * keyboard — so KeyboardAvoidingView's \`frame.y + frame.height - screenY\`
 * works out to ~0 and its \`padding\` behaviour pads nothing. That assumption
 * still holds where adjustResize works (Android 14 and below, iOS), but the app
 * is edge-to-edge, where the OS no longer resizes the window at all.
 *
 * \`endCoordinates.height\` is read off the IME inset on Android and off the
 * keyboard frame on iOS, and it drops to 0 by itself wherever the OS already
 * avoids the keyboard, so reserving exactly this much is right everywhere. It
 * also excludes the bottom system-bar inset, which our own safe-area paddings
 * already reserve.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)

  useEffect(() => {
    const onShow = (event: KeyboardEvent) => setInset(event.endCoordinates.height)
    const onHide = () => setInset(0)

    const subscriptions =
      Platform.OS === "ios"
        ? [Keyboard.addListener("keyboardWillShow", onShow), Keyboard.addListener("keyboardWillHide", onHide)]
        : [Keyboard.addListener("keyboardDidShow", onShow), Keyboard.addListener("keyboardDidHide", onHide)]

    return () => {
      for (const subscription of subscriptions) subscription.remove()
    }
  }, [])

  return inset
}
`

const hookFile = path.join(TARGET, "src", "lib", "keyboard-inset.ts")
if (fs.existsSync(hookFile)) {
  console.error("keyboard-inset.ts already exists: " + hookFile)
  process.exit(1)
}
fs.writeFileSync(hookFile, HOOK)
console.log("src/lib/keyboard-inset.ts: useKeyboardInset hook added")

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

function replaceAllChecked(haystack, needle, replacement, expected, label, rel) {
  const count = haystack.split(needle).length - 1
  if (count !== expected) {
    console.error(rel + " patch FAILED: expected " + expected + ' x "' + label + '", found ' + count)
    process.exit(1)
  }
  return haystack.split(needle).join(replacement)
}

function replaceRegexOnce(haystack, regex, replacement, label, rel) {
  if (!regex.test(haystack)) {
    console.error(rel + " patch FAILED: pattern not found: " + label)
    process.exit(1)
  }
  return haystack.replace(regex, replacement)
}

// --- app/session/[id].tsx ----------------------------------------------------

const sessionRel = "app/session/[id].tsx"
let session = read(sessionRel)

// KeyboardAvoidingView and Platform are both unused once the tag is gone.
session = replaceOnce(
  session,
  "  StyleSheet,\n  useColorScheme,\n  KeyboardAvoidingView,\n  Platform,\n  ActivityIndicator,\n",
  "  StyleSheet,\n  useColorScheme,\n  ActivityIndicator,\n",
  "react-native imports",
  sessionRel,
)

session = replaceOnce(
  session,
  'import { useSessions } from "../../src/stores/sessions"',
  'import { useKeyboardInset } from "../../src/lib/keyboard-inset"\nimport { useSessions } from "../../src/stores/sessions"',
  "keyboard-inset import",
  sessionRel,
)

session = replaceOnce(
  session,
  "  const insets = useSafeAreaInsets()\n",
  "  const insets = useSafeAreaInsets()\n  // Bottom UI (toolbar + composer) has to clear the keyboard: see the hook.\n  const keyboardInset = useKeyboardInset()\n",
  "hook call",
  sessionRel,
)

// The whole opening tag, comment block included — the behaviour it described no
// longer applies, and the comment would be actively misleading left behind.
session = replaceRegexOnce(
  session,
  /      <KeyboardAvoidingView\n(?:[^\n]*\n)*?      >\n/,
  "      <View style={[s.container, isDark && s.containerDark, { paddingBottom: keyboardInset }]}>\n",
  "KeyboardAvoidingView opening tag",
  sessionRel,
)

session = replaceOnce(session, "      </KeyboardAvoidingView>\n", "      </View>\n", "KeyboardAvoidingView closing tag", sessionRel)

write(sessionRel, session)
console.log(sessionRel + ": composer now clears the keyboard")

// --- app/connection/add.tsx + app/connection/[id].tsx ------------------------

for (const rel of ["app/connection/add.tsx", "app/connection/[id].tsx"]) {
  let src = read(rel)

  src = replaceOnce(
    src,
    'import { useTranslation } from "react-i18next"\n',
    'import { useTranslation } from "react-i18next"\nimport { useKeyboardInset } from "../../src/lib/keyboard-inset"\n',
    "keyboard-inset import",
    rel,
  )

  src = replaceOnce(
    src,
    "  const { t } = useTranslation()\n",
    "  const { t } = useTranslation()\n  // These forms are plain ScrollViews with no keyboard avoidance at all.\n  const keyboardInset = useKeyboardInset()\n",
    "hook call",
    rel,
  )

  // 32 is styles.content.paddingBottom — the form's own trailing space, which
  // the keyboard inset is added on top of so the last field still scrolls clear.
  const forms = rel === "app/connection/add.tsx" ? 2 : 1
  src = replaceAllChecked(
    src,
    "      contentContainerStyle={styles.content}\n",
    "      contentContainerStyle={[styles.content, { paddingBottom: 32 + keyboardInset }]}\n",
    forms,
    "contentContainerStyle",
    rel,
  )

  write(rel, src)
  console.log(rel + ": " + forms + " form(s) now clear the keyboard")
}
