const fs = require("fs")
const path = require("path")

// Autosave for what the user has typed but not sent.
//
// Closing the app (or switching sessions) used to throw the composer's text
// away, which for a long prompt is a genuinely painful loss. This adds a small
// per-session draft store and wires the chat composer to it:
//
//   * every keystroke schedules a write, debounced 1.2s, so a long pause
//     followed by app kill still has the text on disk;
//   * the write also happens when the input loses focus and when the session
//     screen unmounts (its cleanup, so navigating away mid-sentence is safe);
//   * restoring happens once, when the session id is known, and never
//     overwrites a draft the user is currently editing;
//   * an emptied input deletes the stored draft instead of keeping "" around.
//
// Storage is AsyncStorage (not SecureStore): drafts are ordinary user text, and
// SecureStore is keyed for a handful of credentials — writing every keystroke
// into the Keystore would be both slow and the wrong store.

const TARGET = process.argv[2]
if (!TARGET) {
  console.error("usage: node patch-drafts.js <repo-root>")
  process.exit(1)
}

// --- new: src/lib/session-draft.ts ------------------------------------------

const DRAFT_LIB = `import { useCallback, useEffect, useRef, useState } from "react"
import AsyncStorage from "@react-native-async-storage/async-storage"

const PREFIX = "opencode_draft_"
const DEBOUNCE_MS = 1200

// Drafts are keyed per session so switching chats doesn't shuffle text between
// conversations. The "new" scope holds the composer when no session id is known
// yet (a brand new chat from the FAB).
export type DraftScope = string

function key(scope: DraftScope): string {
  return PREFIX + scope
}

export async function readDraft(scope: DraftScope): Promise<string> {
  try {
    return (await AsyncStorage.getItem(key(scope))) ?? ""
  } catch {
    return ""
  }
}

export async function writeDraft(scope: DraftScope, text: string): Promise<void> {
  try {
    if (text.trim() === "") await AsyncStorage.removeItem(key(scope))
    else await AsyncStorage.setItem(key(scope), text)
  } catch {
    // A failed autosave must never break typing; the next debounce retries.
  }
}

export interface DraftState {
  /**
   * The draft read back for the current scope, or null while none has been read
   * yet. One entry per scope change, so an effect keyed on it runs exactly once
   * per session rather than on every keystroke.
   */
  restored: { scope: DraftScope; text: string } | null
  /** Call from onChangeText — debounced write + immediate in-memory update. */
  setDraft: (text: string) => void
  /** Call on blur / before navigating away to flush a pending write. */
  flush: () => void
  /** Forget the stored draft (e.g. right after the message was sent). */
  clear: () => void
}

/**
 * Debounced per-scope draft. The scope may be undefined while the screen is still
 * resolving its session — nothing is read or written until it is known, so the
 * text typed in that window simply isn't autosaved (and stays in the input).
 */
export function useSessionDraft(scope: DraftScope | undefined): DraftState {
  const [restored, setRestored] = useState<{ scope: DraftScope; text: string } | null>(null)
  const pending = useRef<{ scope: DraftScope; text: string } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Read the stored draft once per scope. Emitting an entry even when the text
  // is empty is what makes switching to a session with no draft clear the
  // composer, instead of leaving the previous session's text behind.
  useEffect(() => {
    if (!scope) return
    let cancelled = false
    void readDraft(scope).then((text) => {
      if (cancelled) return
      setRestored({ scope, text })
    })
    return () => {
      cancelled = true
    }
  }, [scope])

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const job = pending.current
    pending.current = null
    if (job) void writeDraft(job.scope, job.text)
  }, [])

  const setDraft = useCallback(
    (text: string) => {
      // No state update here on purpose: the composer already owns the text, so
      // a keystroke would otherwise re-render the whole session screen twice.
      if (!scope) return
      pending.current = { scope, text }
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        timer.current = null
        const job = pending.current
        pending.current = null
        if (job) void writeDraft(job.scope, job.text)
      }, DEBOUNCE_MS)
    },
    [scope],
  )

  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    pending.current = null
    if (scope) {
      setRestored({ scope, text: "" })
      void writeDraft(scope, "")
    }
  }, [scope])

  // Never leave a debounce pending: unmount flushes it, which is what makes
  // navigating to another session (or backgrounding the app) safe.
  useEffect(() => flush, [flush])

  return { restored, setDraft, flush, clear }
}
`

const draftFile = path.join(TARGET, "src", "lib", "session-draft.ts")
if (fs.existsSync(draftFile)) {
  console.error("patch-drafts: refusing to overwrite existing session-draft.ts")
  process.exit(1)
}
fs.writeFileSync(draftFile, DRAFT_LIB)
console.log("src/lib/session-draft.ts: debounced per-session drafts")

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

// --- app/session/[id].tsx: wire the composer ---------------------------------

const rel = "app/session/[id].tsx"
let src = read(rel)

src = replaceOnce(
  src,
  'import { useKeyboardInset } from "../../src/lib/keyboard-inset"',
  'import { useKeyboardInset } from "../../src/lib/keyboard-inset"\n' +
    'import { useSessionDraft } from "../../src/lib/session-draft"',
  "keyboard-inset import",
  rel,
)

src = replaceOnce(
  src,
  `  const [input, setInput] = useState("")`,
  `  // Draft autosave: keyed by session id so each conversation keeps its own
  // unsent text; the hook debounces the write and flushes on unmount.
  const draft = useSessionDraft(id || undefined)
  const [input, setInput] = useState("")`,
  "input state",
  rel,
)

// A new session's text must start from the restored draft, but only once — a
// late restore must not clobber what the user types in the meantime.
src = replaceOnce(
  src,
  `  const slashActive = input.startsWith("/") && !input.includes(" ")`,
  `  // Each restored draft is applied at most once (keyed by the scope it was
  // read for) and never over text that is already in the composer.
  const appliedDraftScope = useRef<string | undefined>(undefined)
  useEffect(() => {
    const entry = draft.restored
    if (!entry || appliedDraftScope.current === entry.scope) return
    appliedDraftScope.current = entry.scope
    if (!input) setInput(entry.text)
  }, [draft.restored, input])

  const updateInput = useCallback(
    (text: string) => {
      setInput(text)
      draft.setDraft(text)
    },
    [draft.setDraft],
  )

  const slashActive = input.startsWith("/") && !input.includes(" ")`,
  "draft -> input",
  rel,
)

// Sending clears the stored draft too.
src = replaceOnce(
  src,
  `    const text = input.trim()
    const files = [...attachments]
    setInput("")
    setAttachments([])`,
  `    const text = input.trim()
    const files = [...attachments]
    setInput("")
    draft.clear()
    setAttachments([])`,
  "send clears draft",
  rel,
)

// Optimistic-restore on failure keeps the text in the draft store.
src = replaceOnce(
  src,
  `      // Restore the user's text and attachments so their input isn't lost.
      setInput((prev) => (prev ? prev : text))`,
  `      // Restore the user's text and attachments so their input isn't lost.
      setInput((prev) => (prev ? prev : text))
      if (!input) draft.setDraft(text)`,
  "send failure keeps draft",
  rel,
)

src = replaceOnce(
  src,
  `              value={speech.listening ? speech.transcript : input}
              onChangeText={speech.listening ? undefined : setInput}`,
  `              value={speech.listening ? speech.transcript : input}
              onChangeText={speech.listening ? undefined : updateInput}
              onBlur={() => draft.flush()}`,
  "TextInput",
  rel,
)

save(rel, src)
console.log(rel + ": composer autosaves and restores its draft")
