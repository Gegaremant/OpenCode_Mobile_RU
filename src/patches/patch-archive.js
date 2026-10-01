const fs = require("fs")
const path = require("path")

// Session archive + transcript export.
//
// The server already models all of this (Session.time.archived), but the mobile
// client had no way to reach it and no list of archived sessions. What the
// server does, read from sst/opencode v1.18.32:
//
//   * GET /experimental/session  — "Archived sessions are excluded by default"
//     (`if (!input?.archived) conditions.push(isNull(time_archived))`), and
//     `archived=true` applies no filter at all, i.e. it returns active *and*
//     archived. One request is therefore enough to render both views.
//   * PATCH /session/:id with `time.archived` — the handler runs
//     `if (ctx.payload.time?.archived !== undefined) setArchived(...)`, and
//     `archived: null` fails the `Schema.Finite` payload schema.
//
// That last point means "un-archive" has no literal API call: the only value we
// can send is a number, and 0 is the one that reads as *not* archived
// (`time_archived == NULL` is the server's archive test, so 0 keeps the session
// out of the server's own default listing, but every client that filters on
// `time.archived` truthiness — this app, the TUI — treats it as active again).
// setSessionArchived() therefore documents the trade-off at the one call site.
//
// --- v2 (opencode /api/* rewrite) --------------------------------------------
//
// The v2 surface answers both halves differently, verified against the route
// definitions in anomalyco/opencode (packages/protocol/src/groups/session.ts):
//
//   * LISTING still works. `GET /api/session` takes no `archived` parameter and
//     applies no archive filter of its own (the v2 list query is workspace /
//     limit / order / search / directory / project / subpath / cursor), so it
//     returns active *and* archived rows in one response — `time.archived` is
//     still part of the v2 Session.Info schema. Filtering client-side is
//     therefore both necessary and sufficient, and the `?archived=true` query
//     stays a v1-only detail.
//
//   * WRITING does not work. The v2 endpoint table has `GET /api/session/:id`
//     and nothing else — no PATCH — so there is no call that could set the
//     flag. The archive actions stay visible and report this honestly instead
//     of pretending to work; archiveIsSupported() is the single place that
//     decides, and the UI keys off the connection's probed `api`.

const TARGET = process.argv[2]
if (!TARGET) {
  console.error("usage: node patch-archive.js <repo-root>")
  process.exit(1)
}

// --- new: src/lib/session-archive.ts ----------------------------------------

const ARCHIVE_LIB = `import { Share } from "react-native"
import type { Client, MessageWithParts, Session } from "./sdk"

export interface TranscriptLabels {
  user: string
  assistant: string
  untitled: string
  project: string
  updated: string
}

// Restoring sends 0 rather than "no value": the server's PATCH handler skips
// \`time.archived === undefined\` and its payload schema rejects null, so 0 is
// the only un-archiving value the API accepts. See the header comment in
// patch-archive.js for what that does and does not restore.
const UNARCHIVED = 0

/** Truthiness, matching how every client (and the TUI) reads the flag. */
export function isArchived(session: Session): boolean {
  return !!session.time?.archived
}

export function splitArchived(sessions: Session[]): { active: Session[]; archived: Session[] } {
  const active: Session[] = []
  const archived: Session[] = []
  for (const session of sessions) (isArchived(session) ? archived : active).push(session)
  return { active, archived }
}

/**
 * Whether this connection's server can record the archive flag.
 *
 * "v1" (and an unprobed connection, which the client treats as v2 today) can:
 * \`PATCH /session/:id\` takes \`time.archived\`. "v2" cannot — its route table
 * has \`GET /api/session/:id\` and no PATCH, so no call exists that could set
 * the flag. Reading is fine on both: v2 lists active and archived rows together
 * and still reports \`time.archived\`.
 *
 * Declared as a plain string union rather than importing ServerApi, because
 * src/lib/api-detect.ts only exists on the v2 client generation — this file has
 * to compile against both.
 */
export function archiveIsSupported(api: string | undefined): boolean {
  return api !== "v2"
}

/** Thrown instead of firing a request that cannot work. See archiveIsSupported. */
export class ArchiveUnsupportedError extends Error {
  constructor() {
    super("The connected server's v2 API has no session-archive endpoint")
    this.name = "ArchiveUnsupportedError"
  }
}

export async function setSessionArchived(
  client: Client,
  sessionID: string,
  archived: boolean,
  api?: string,
): Promise<void> {
  if (!archiveIsSupported(api)) throw new ArchiveUnsupportedError()
  await client.session.update(sessionID, { time: { archived: archived ? Date.now() : UNARCHIVED } })
}

export function buildTranscript(
  session: Session,
  messages: MessageWithParts[],
  labels: TranscriptLabels,
): string {
  const lines: string[] = []
  lines.push("# " + (session.title || labels.untitled))
  lines.push("")
  lines.push("- " + labels.project + ": " + (session.directory || "—"))
  lines.push("- " + labels.updated + ": " + new Date(session.time.updated).toLocaleString())
  lines.push("")
  for (const message of messages || []) {
    const text = (message.parts || [])
      .filter((part) => part.type === "text" && part.text?.trim())
      .map((part) => (part.text || "").trim())
      .join("\\n\\n")
    if (!text) continue
    lines.push("## " + (message.info.role === "user" ? labels.user : labels.assistant))
    lines.push("")
    lines.push(text)
    lines.push("")
  }
  return lines.join("\\n")
}

/** Fetch the whole conversation and hand it to the OS share sheet. */
export async function shareTranscript(
  client: Client,
  session: Session,
  labels: TranscriptLabels,
): Promise<string> {
  const messages = await client.session.messages(session.id)
  const text = buildTranscript(session, messages, labels)
  await Share.share({ title: session.title || labels.untitled, message: text })
  return text
}
`

// --- new: src/components/ActionSheet.tsx -------------------------------------

// Alert.alert is unusable for a row menu here: RN truncates Android button
// lists to three (Libraries/Alert/Alert.js — \`buttons.slice(0, 3)\`), and the
// menu needs Rename + Archive/Restore + Share + Copy + Delete. Same reason
// src/patches/patch-settings.js replaced the language Alert with a Modal.
const ACTION_SHEET = `import { Modal, Pressable, StyleSheet, Text, View } from "react-native"
import { Ionicons } from "@expo/vector-icons"

export interface ActionSheetAction {
  label: string
  icon?: keyof typeof Ionicons.glyphMap
  destructive?: boolean
  onPress: () => void
}

interface Props {
  visible: boolean
  title?: string
  actions: ActionSheetAction[]
  cancelLabel: string
  isDark: boolean
  onClose: () => void
}

/**
 * Modal-backed row menu. A Modal (not Alert.alert) because Android's
 * Alert.alert silently drops every button past the third — see
 * Libraries/Alert/Alert.js.
 */
export function ActionSheet({ visible, title, actions, cancelLabel, isDark, onClose }: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        {/* Swallow presses inside the card so they don't dismiss the sheet. */}
        <Pressable onPress={() => {}}>
          <View style={[styles.card, isDark && styles.cardDark]}>
            {title ? (
              <Text style={[styles.title, isDark && styles.titleDark]} numberOfLines={2}>
                {title}
              </Text>
            ) : null}
            {actions.map((action) => (
              <Pressable
                key={action.label}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed, isDark && styles.rowDark]}
                onPress={() => {
                  onClose()
                  // Let the sheet finish dismissing before the action opens its
                  // own modal/dialog — a native Modal still on screen would sit
                  // on top of an Alert raised in the same tick.
                  setTimeout(action.onPress, 250)
                }}
              >
                {action.icon ? (
                  <Ionicons
                    name={action.icon}
                    size={20}
                    color={action.destructive ? "#ef4444" : isDark ? "#e5e5e5" : "#0a0a0a"}
                  />
                ) : null}
                <Text
                  style={[
                    styles.rowLabel,
                    isDark && styles.rowLabelDark,
                    action.destructive && styles.rowLabelDestructive,
                  ]}
                >
                  {action.label}
                </Text>
              </Pressable>
            ))}
            <Pressable style={styles.cancel} onPress={onClose}>
              <Text style={[styles.cancelLabel, isDark && styles.cancelLabelDark]}>{cancelLabel}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
  },
  card: {
    width: "84%",
    maxWidth: 380,
    borderRadius: 14,
    backgroundColor: "#ffffff",
    paddingVertical: 6,
    overflow: "hidden",
  },
  cardDark: {
    backgroundColor: "#1a1a1a",
  },
  title: {
    fontSize: 14,
    fontWeight: "600",
    color: "#0a0a0a",
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  titleDark: {
    color: "#ffffff",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  rowDark: {
    backgroundColor: "#1a1a1a",
  },
  rowPressed: {
    backgroundColor: "rgba(139,92,246,0.12)",
  },
  rowLabel: {
    fontSize: 16,
    color: "#0a0a0a",
    flex: 1,
  },
  rowLabelDark: {
    color: "#e5e5e5",
  },
  rowLabelDestructive: {
    color: "#ef4444",
  },
  cancel: {
    borderTopWidth: 1,
    borderTopColor: "#e5e5e5",
    marginTop: 6,
  },
  cancelLabel: {
    fontSize: 16,
    color: "#666666",
    textAlign: "center",
    paddingVertical: 14,
  },
  cancelLabelDark: {
    color: "#999999",
  },
})
`

function write(rel, contents) {
  const p = path.join(TARGET, rel)
  if (fs.existsSync(p)) {
    console.error("patch-archive: refusing to overwrite existing " + rel)
    process.exit(1)
  }
  fs.writeFileSync(p, contents)
  console.log(rel + ": added")
}

write(path.join("src", "lib", "session-archive.ts"), ARCHIVE_LIB)
write(path.join("src", "components", "ActionSheet.tsx"), ACTION_SHEET)

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

function replaceAllChecked(haystack, needle, replacement, expected, label, rel) {
  const count = haystack.split(needle).length - 1
  if (count !== expected) {
    console.error(rel + " patch FAILED: expected " + expected + ' x "' + label + '", found ' + count)
    process.exit(1)
  }
  return haystack.split(needle).join(replacement)
}

// --- src/lib/session-list.ts: teach the global list about ?archived=true -----

const listRel = "src/lib/session-list.ts"
let list = read(listRel)

list = replaceOnce(
  list,
  `export interface SessionListParams {
  roots?: boolean
  limit?: number
  search?: string
}`,
  `export interface SessionListParams {
  roots?: boolean
  limit?: number
  search?: string
  // "include archived too". The server hides archived sessions from the
  // default listing (WHERE time_archived IS NULL) and applies NO archived
  // filter at all when this is true, so one request with it returns both
  // sides and the caller splits them on time.archived.
  archived?: boolean
}`,
  "SessionListParams",
  listRel,
)

list = replaceOnce(
  list,
  `  getExperimental: () => Promise<Session[] | null>`,
  `  getExperimental: (query?: string) => Promise<Session[] | null>`,
  "transport signature",
  listRel,
)

list = replaceOnce(
  list,
  `// Build the query string for the legacy directory-scoped /session fallback,`,
  `// Query for the global listing. Only \`archived\` is sent: \`limit\` would
// truncate the pool before normalizeSessions can filter, and \`roots\`/
// \`search\` are applied client-side on purpose.
export function experimentalSessionQuery(params?: SessionListParams): string {
  if (!params?.archived) return ""
  return "?archived=true"
}

// Build the query string for the legacy directory-scoped /session fallback,`,
  "experimentalSessionQuery",
  listRel,
)

list = replaceOnce(
  list,
  "  const all = await transport.getExperimental()",
  "  const all = await transport.getExperimental(experimentalSessionQuery(params))",
  "getExperimental call",
  listRel,
)

save(listRel, list)
console.log(listRel + ": ?archived=true support")

// --- the v1 transport: forward that query -----------------------------------
//
// The transport that talks /experimental/session moved between client
// generations: src/lib/sdk.ts while the client only spoke v1, src/lib/sdk-v1.ts
// once it grew a second transport. Patch whichever file carries the route.

const V1_LISTENERS = ["src/lib/sdk-v1.ts", "src/lib/sdk.ts"].filter((rel) =>
  fs.existsSync(path.join(TARGET, rel)),
)

const V1_LIST_OLD = `      list: (params?: { roots?: boolean; limit?: number; search?: string }): Promise<Session[]> =>
        loadSessionList(
          {
            getExperimental: async (): Promise<Session[] | null> => {
              const response = await fetchWithTimeout(\`\${config.baseUrl}/experimental/session\`, {`

const V1_LIST_NEW = `      list: (params?: { roots?: boolean; limit?: number; search?: string; archived?: boolean }): Promise<Session[]> =>
        loadSessionList(
          {
            getExperimental: async (query?: string): Promise<Session[] | null> => {
              const response = await fetchWithTimeout(\`\${config.baseUrl}/experimental/session\${query ?? ""}\`, {`

const v1Rel = V1_LISTENERS.find((rel) => read(rel).includes(V1_LIST_OLD))
if (!v1Rel) {
  console.error("v1 session.list patch FAILED: marker not found in any of: " + V1_LISTENERS.join(", "))
  process.exit(1)
}

save(
  v1Rel,
  replaceOnce(read(v1Rel), V1_LIST_OLD, V1_LIST_NEW, "session.list", v1Rel),
)
console.log(v1Rel + ": session.list forwards the archive query")

// --- the v2 transport: accept the flag, ignore it ----------------------------
//
// GET /api/session applies no archive filter, so it already returns both sides
// and the query would be meaningless — but the shared SessionListParams gained
// `archived`, and the archive UI passes it on both generations. Widening the
// signature keeps that call site type-clean and documents why it is dropped.

const V2_LIST_OLD = `      list: (params?: { roots?: boolean; limit?: number; search?: string }): Promise<Session[]> =>
        loadSessionList(
          {
            getExperimental: async (): Promise<Session[] | null> => {
              const response = await fetchWithTimeout(\`\${config.baseUrl}/api/session?limit=500&order=desc\`, {`

const V2_LIST_NEW = `      // \`archived\` is accepted for parity with the v1 transport and deliberately
      // ignored: GET /api/session takes no archive filter and returns active and
      // archived rows together, so the caller filters on time.archived itself.
      list: (params?: { roots?: boolean; limit?: number; search?: string; archived?: boolean }): Promise<Session[]> =>
        loadSessionList(
          {
            getExperimental: async (_query?: string): Promise<Session[] | null> => {
              const response = await fetchWithTimeout(\`\${config.baseUrl}/api/session?limit=500&order=desc\`, {`

const v2Rel = V1_LISTENERS.find((rel) => read(rel).includes(V2_LIST_OLD))
if (v2Rel) {
  save(
    v2Rel,
    replaceOnce(read(v2Rel), V2_LIST_OLD, V2_LIST_NEW, "v2 session.list", v2Rel),
  )
  console.log(v2Rel + ": session.list accepts (and ignores) archived — v2 needs no filter")
}

// --- app/(tabs)/index.tsx: the archive UI ------------------------------------

const listRel2 = "app/(tabs)/index.tsx"
let screen = read(listRel2)

// ServerConnection.api only exists on the v2 client generation (it is written by
// probeServer/api-detect). Referencing it on a v1-only tree would not compile, so
// the expression is chosen per tree rather than guarded at runtime.
const hasApiField = fs.existsSync(path.join(TARGET, "src", "lib", "api-detect.ts"))
const SERVER_API_EXPR = hasApiField ? "activeConnection?.api" : "undefined"

screen = replaceOnce(
  screen,
  `import { router, useFocusEffect } from "expo-router"`,
  `import { router, useFocusEffect } from "expo-router"
import * as Clipboard from "expo-clipboard"`,
  "expo-router import",
  listRel2,
)

screen = replaceOnce(
  screen,
  `import { nameOf } from "../../src/lib/path-utils"`,
  `import { nameOf } from "../../src/lib/path-utils"
import { ActionSheet } from "../../src/components/ActionSheet"
import { archiveIsSupported, isArchived, setSessionArchived, shareTranscript, buildTranscript, type TranscriptLabels } from "../../src/lib/session-archive"`,
  "path-utils import",
  listRel2,
)

// --- SessionItem + GroupHeader: rewritten wholesale -------------------------
//
// Both are leaf components with no internal dependencies beyond useTranslation,
// so replacing them whole (delimited by their own leading comment / the next
// top-level declaration) is both the most readable result and the least
// fragile marker. The Alert menus become ActionSheet sheets because Android's
// Alert.alert keeps only three buttons (Libraries/Alert/Alert.js) and these
// menus need five / a project-wide action.

function replaceBlock(src, startMarker, endMarker, replacement, label, rel) {
  const start = src.indexOf(startMarker)
  const end = src.indexOf(endMarker, start + startMarker.length)
  if (start === -1 || end === -1) {
    console.error(rel + " patch FAILED: block not found: " + label)
    process.exit(1)
  }
  return src.slice(0, start) + replacement + src.slice(end)
}

const SESSION_ITEM = `function SessionItem({
  session,
  isDark,
  onRename,
  onDelete,
  onArchive,
  onRestore,
  onShare,
  onCopy,
}: {
  session: Session
  isDark: boolean
  onRename: () => void
  onDelete: () => void
  onArchive: () => void
  onRestore: () => void
  onShare: () => void
  onCopy: () => void
}) {
  const { t } = useTranslation()
  const [menuVisible, setMenuVisible] = useState(false)
  const archived = isArchived(session)

  const onPress = () => {
    router.push({
      pathname: \`/session/[id]\`,
      params: { id: session.id, ...(session.directory ? { directory: session.directory } : {}) },
    })
  }

  // Extract short directory name from session
  const shortDir = session.directory ? session.directory.split("/").filter(Boolean).pop() : null

  return (
    <>
      <TouchableOpacity
        style={[styles.sessionItem, isDark && styles.sessionItemDark]}
        onPress={onPress}
        onLongPress={() => setMenuVisible(true)}
        testID={\`session-item-\${session.id}\`}
      >
        <View style={styles.sessionContent}>
          <View style={styles.sessionHeader}>
            <Text style={[styles.sessionTitle, isDark && styles.textDark]} numberOfLines={1}>
              {session.title || t("sessionsList.untitledSession")}
            </Text>
            {archived && (
              <View style={[styles.archivedBadge, isDark && styles.archivedBadgeDark]}>
                <Ionicons name="archive-outline" size={11} color={isDark ? "#a1a1aa" : "#6b7280"} />
                <Text style={[styles.archivedBadgeText, isDark && styles.metaDark]}>
                  {t("sessionsList.archive.badge")}
                </Text>
              </View>
            )}
          </View>
          <View style={styles.sessionMetaRow}>
            <Text style={[styles.sessionMeta, isDark && styles.metaDark]}>
              {formatTime(session.time.updated, t)}
              {/* summary is always present but files defaults to 0 until the
                  server populates it — only show the count when it is meaningful,
                  matching the SessionInfo panel's \`summary.files > 0\` guard (#55) */}
              {session.summary && session.summary.files > 0 &&
                \` · \${t("sessionsList.filesCount", { count: session.summary.files })}\`}
            </Text>
            {shortDir && (
              <View style={styles.sessionDirBadge}>
                <Ionicons name="folder-outline" size={12} color={isDark ? "#888888" : "#666666"} />
                <Text style={[styles.sessionDirText, isDark && styles.metaDark]}>{shortDir}</Text>
              </View>
            )}
          </View>
        </View>
        <Ionicons name="chevron-forward" size={20} color={isDark ? "#666666" : "#999999"} />
      </TouchableOpacity>

      <ActionSheet
        visible={menuVisible}
        title={session.title || t("sessionsList.untitledSession")}
        cancelLabel={t("common.cancel")}
        isDark={isDark}
        onClose={() => setMenuVisible(false)}
        actions={[
          { label: t("sessionsList.actions.rename"), icon: "create-outline", onPress: onRename },
          archived
            ? { label: t("sessionsList.archive.actions.restore"), icon: "refresh-outline", onPress: onRestore }
            : { label: t("sessionsList.archive.actions.archive"), icon: "archive-outline", onPress: onArchive },
          { label: t("sessionsList.archive.actions.share"), icon: "share-outline", onPress: onShare },
          { label: t("sessionsList.archive.actions.copy"), icon: "copy-outline", onPress: onCopy },
          { label: t("common.delete"), icon: "trash-outline", destructive: true, onPress: onDelete },
        ]}
      />
    </>
  )
}

`

screen = replaceBlock(
  screen,
  "function SessionItem({",
  "// Flattened list row",
  SESSION_ITEM,
  "SessionItem",
  listRel2,
)

const GROUP_HEADER = `function GroupHeader({
  row,
  isDark,
  onToggle,
  onProjectAction,
  projectActionLabel,
}: {
  row: { directory: string; shortName: string; count: number; collapsed: boolean }
  isDark: boolean
  onToggle: () => void
  onProjectAction: () => void
  projectActionLabel: string
}) {
  const { t } = useTranslation()
  const [menuVisible, setMenuVisible] = useState(false)

  return (
    <>
      <TouchableOpacity
        style={[styles.groupHeader, isDark && styles.groupHeaderDark]}
        onPress={onToggle}
        activeOpacity={0.7}
        testID={\`group-header-\${row.directory}\`}
      >
        <Ionicons name="folder-outline" size={16} color={isDark ? "#8b5cf6" : "#6d28d9"} />
        <Text style={[styles.groupHeaderText, isDark && styles.textDark]} numberOfLines={1}>
          {row.shortName}
        </Text>
        <Text style={[styles.groupHeaderCount, isDark && styles.metaDark]}>{row.count}</Text>
        {/* Whole-project actions (archive / restore every chat at once). The
            inner touchable wins the responder, so tapping it opens the sheet
            instead of collapsing the group. */}
        <TouchableOpacity
          onPress={() => setMenuVisible(true)}
          hitSlop={10}
          style={styles.groupHeaderMenu}
          testID={\`group-header-menu-\${row.directory}\`}
        >
          <Ionicons name="ellipsis-horizontal" size={16} color={isDark ? "#666666" : "#999999"} />
        </TouchableOpacity>
        <Ionicons
          name={row.collapsed ? "chevron-forward" : "chevron-down"}
          size={16}
          color={isDark ? "#666666" : "#999999"}
        />
      </TouchableOpacity>

      <ActionSheet
        visible={menuVisible}
        title={row.shortName}
        cancelLabel={t("common.cancel")}
        isDark={isDark}
        onClose={() => setMenuVisible(false)}
        actions={[{ label: projectActionLabel, icon: "archive-outline", onPress: onProjectAction }]}
      />
    </>
  )
}

`

screen = replaceBlock(
  screen,
  "function GroupHeader({",
  "// Get short directory name",
  GROUP_HEADER,
  "GroupHeader",
  listRel2,
)

// --- SessionsScreen: state, handlers, toggle bar, wiring ---------------------

screen = replaceOnce(
  screen,
  `  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set())`,
  `  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set())

  // Archive view. On v1 the server hides archived sessions from its default
  // listing, so the archive is fetched separately (with archived=true, which
  // disables that filter and therefore returns both sides) instead of
  // piggy-backing on loadSessions(), whose pool is capped by \`limit\`. On v2 the
  // listing applies no archive filter at all, so the same call already returns
  // both sides and the client-side isArchived() filter does the split.
  //
  // serverApi is the connection's probed API generation. It only exists on the
  // v2 client (ServerConnection.api, set by api-detect); on the v1-only client
  // every server predates the /api/ rewrite, so the value is pinned to undefined.
  const serverApi: string | undefined = ${SERVER_API_EXPR}
  const [showArchived, setShowArchived] = useState(false)
  const [archivedSessions, setArchivedSessions] = useState<Session[]>([])
  const [archiveBusy, setArchiveBusy] = useState(false)

  const transcriptLabels = useMemo<TranscriptLabels>(
    () => ({
      user: t("sessionsList.export.roleUser"),
      assistant: t("sessionsList.export.roleAssistant"),
      untitled: t("sessionsList.untitledSession"),
      project: t("sessionsList.export.project"),
      updated: t("sessionsList.export.updated"),
    }),
    [t],
  )

  const clientFor = useCallback(
    (directory?: string) => (directory ? (clientForDirectory(directory) ?? client) : client),
    [client, clientForDirectory],
  )

  const loadArchived = useCallback(async () => {
    const listClient = clientForDirectory(undefined) || client
    if (!listClient) return
    try {
      const all = await listClient.session.list({ roots: true, limit: 200, archived: true })
      setArchivedSessions(all.filter((session) => isArchived(session)))
    } catch (err) {
      console.error("Failed to load archived sessions:", err)
    }
  }, [client, clientForDirectory])

  const refreshBoth = useCallback(async () => {
    await Promise.all([loadSessions(), loadArchived()])
  }, [loadSessions, loadArchived])

  const visibleSessions = showArchived ? archivedSessions : sessions`,
  "archive state",
  listRel2,
)

screen = replaceOnce(
  screen,
  `  const rows = useMemo<ListRow[]>(() => {
    const groups = groupByDirectory(sessions)
    if (groups.length <= 1) {
      return sessions.map((session) => ({ type: "session", session }))
    }`,
  `  const rows = useMemo<ListRow[]>(() => {
    const groups = groupByDirectory(visibleSessions)
    if (groups.length <= 1) {
      return visibleSessions.map((session) => ({ type: "session", session }))
    }`,
  "rows source",
  listRel2,
)

screen = replaceOnce(
  screen,
  `  }, [sessions, collapsedDirs])`,
  `  }, [visibleSessions, collapsedDirs])`,
  "rows deps",
  listRel2,
)

// Load the archive when the user first opens the tab.
screen = replaceOnce(
  screen,
  `  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await Promise.all([loadSessions(), refreshProject()])`,
  `  useEffect(() => {
    if (showArchived) void loadArchived()
  }, [showArchived, loadArchived])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await Promise.all([refreshBoth(), refreshProject()])`,
  "onRefresh",
  listRel2,
)

screen = replaceOnce(
  screen,
  `  }, [loadSessions, refreshProject])`,
  `  }, [refreshBoth, refreshProject])`,
  "onRefresh deps",
  listRel2,
)

// Archive / restore / export handlers, inserted before onCreateSession.
screen = replaceOnce(
  screen,
  `  const onCreateSession = async () => {`,
  `  const runArchiveJob = useCallback(
    async (targets: Session[], archived: boolean) => {
      if (targets.length === 0 || archiveBusy) return
      // v2 exposes no session-update endpoint, so there is nothing to call.
      // Say so plainly instead of confirming a dialog whose action cannot work.
      if (!archiveIsSupported(serverApi)) {
        Alert.alert(
          t("sessionsList.archive.alerts.unsupportedTitle"),
          t("sessionsList.archive.alerts.unsupportedMessage"),
        )
        return
      }
      const verb = archived ? t("sessionsList.archive.actions.archive") : t("sessionsList.archive.actions.restore")
      Alert.alert(
        t("sessionsList.archive.confirmTitle", { verb }),
        t("sessionsList.archive.confirmMessage", { count: targets.length }),
        [
          { text: t("common.cancel"), style: "cancel" },
          {
            text: verb,
            onPress: async () => {
              setArchiveBusy(true)
              let failed = 0
              for (const session of targets) {
                const api = clientFor(session.directory)
                if (!api) {
                  failed++
                  continue
                }
                try {
                  await setSessionArchived(api, session.id, archived, serverApi)
                } catch (err) {
                  console.error("Archive request failed:", err)
                  failed++
                }
              }
              await refreshBoth()
              setArchiveBusy(false)
              if (failed > 0) {
                Alert.alert(
                  t("sessionsList.archive.alerts.partialTitle"),
                  t("sessionsList.archive.alerts.partialMessage", {
                    done: targets.length - failed,
                    failed,
                  }),
                )
              }
            },
          },
        ],
      )
    },
    [archiveBusy, clientFor, refreshBoth, serverApi, t],
  )

  const handleArchive = useCallback(
    (session: Session) => runArchiveJob([session], true),
    [runArchiveJob],
  )

  const handleRestore = useCallback(
    (session: Session) => runArchiveJob([session], false),
    [runArchiveJob],
  )

  const handleProjectArchive = useCallback(
    (directory: string, archived: boolean) => {
      const pool = showArchived ? archivedSessions : sessions
      runArchiveJob(
        pool.filter((session) => session.directory === directory && isArchived(session) === archived),
        !archived,
      )
    },
    [archivedSessions, runArchiveJob, sessions, showArchived],
  )

  const handleShare = useCallback(
    async (session: Session) => {
      const api = clientFor(session.directory)
      if (!api) return
      try {
        await shareTranscript(api, session, transcriptLabels)
      } catch (err) {
        console.error("Export failed:", err)
        Alert.alert(t("sessionsList.export.alerts.failedTitle"), t("sessionsList.export.alerts.failedMessage"))
      }
    },
    [clientFor, transcriptLabels, t],
  )

  const handleCopy = useCallback(
    async (session: Session) => {
      const api = clientFor(session.directory)
      if (!api) return
      try {
        const messages = await api.session.messages(session.id)
        await Clipboard.setStringAsync(buildTranscript(session, messages, transcriptLabels))
        Alert.alert(t("sessionsList.export.copiedTitle"), t("sessionsList.export.copiedMessage"))
      } catch (err) {
        console.error("Export failed:", err)
        Alert.alert(t("sessionsList.export.alerts.failedTitle"), t("sessionsList.export.alerts.failedMessage"))
      }
    },
    [clientFor, transcriptLabels, t],
  )

  const onCreateSession = async () => {`,
  "archive handlers",
  listRel2,
)

// Toggle bar + row wiring + empty state.
screen = replaceOnce(
  screen,
  `      <UpdateBanner isDark={isDark} />

      <FlatList
        data={rows}
        keyExtractor={(row) => (row.type === "header" ? \`dir:\${row.directory}\` : row.session.id)}
        renderItem={({ item: row }) =>
          row.type === "header" ? (
            <GroupHeader row={row} isDark={isDark} onToggle={() => toggleGroup(row.directory)} />
          ) : (
            <SessionItem
              session={row.session}
              isDark={isDark}
              onRename={() => handleRename(row.session)}
              onDelete={() => handleDelete(row.session)}
            />
          )
        }`,
  `      <UpdateBanner isDark={isDark} />

      {/* Active / Archive switch. */}
      <View style={[styles.archiveBar, isDark && styles.archiveBarDark]}>
        <TouchableOpacity
          style={[styles.archiveTab, !showArchived && styles.archiveTabActive]}
          onPress={() => setShowArchived(false)}
          testID="sessions-tab-active"
        >
          <Text style={[styles.archiveTabText, !showArchived && styles.archiveTabTextActive]}>
            {t("sessionsList.archive.active")}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.archiveTab, showArchived && styles.archiveTabActive]}
          onPress={() => setShowArchived(true)}
          testID="sessions-tab-archived"
        >
          <Ionicons name="archive-outline" size={14} color={showArchived ? "#ffffff" : isDark ? "#888888" : "#666666"} />
          <Text style={[styles.archiveTabText, showArchived && styles.archiveTabTextActive]}>
            {t("sessionsList.archive.archived")}
            {archivedSessions.length > 0 ? \` (\${archivedSessions.length})\` : ""}
          </Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(row) => (row.type === "header" ? \`dir:\${row.directory}\` : row.session.id)}
        renderItem={({ item: row }) =>
          row.type === "header" ? (
            <GroupHeader
              row={row}
              isDark={isDark}
              onToggle={() => toggleGroup(row.directory)}
              onProjectAction={() => handleProjectArchive(row.directory, showArchived)}
              projectActionLabel={t(
                showArchived ? "sessionsList.archive.actions.restoreProject" : "sessionsList.archive.actions.archiveProject",
              )}
            />
          ) : (
            <SessionItem
              session={row.session}
              isDark={isDark}
              onRename={() => handleRename(row.session)}
              onDelete={() => handleDelete(row.session)}
              onArchive={() => handleArchive(row.session)}
              onRestore={() => handleRestore(row.session)}
              onShare={() => handleShare(row.session)}
              onCopy={() => handleCopy(row.session)}
            />
          )
        }`,
  "archive toggle + row wiring",
  listRel2,
)

screen = replaceOnce(
  screen,
  `            <View style={styles.emptyList}>
              <Text style={[styles.emptyListText, isDark && styles.metaDark]}>{t("sessionsList.empty.noSessions")}</Text>
            </View>
          )
        }
        contentContainerStyle={sessions.length === 0 ? styles.emptyContent : undefined}`,
  `            <View style={styles.emptyList}>
              <Text style={[styles.emptyListText, isDark && styles.metaDark]}>
                {t(showArchived ? "sessionsList.archive.empty" : "sessionsList.empty.noSessions")}
              </Text>
            </View>
          )
        }
        contentContainerStyle={visibleSessions.length === 0 ? styles.emptyContent : undefined}`,
  "empty state",
  listRel2,
)

// Styles for the new chrome.
screen = replaceOnce(
  screen,
  `  errorBar: {
    backgroundColor: "#fef2f2",`,
  `  archiveBar: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#e5e5e5",
  },
  archiveBarDark: {
    borderBottomColor: "#1a1a1a",
  },
  archiveTab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 16,
  },
  archiveTabActive: {
    backgroundColor: "#0a0a0a",
  },
  archiveTabText: {
    fontSize: 13,
    color: "#666666",
  },
  archiveTabTextActive: {
    color: "#ffffff",
    fontWeight: "600",
  },
  archivedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: "#f5f5f5",
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  archivedBadgeDark: {
    backgroundColor: "#2a2a2a",
  },
  archivedBadgeText: {
    fontSize: 10,
    color: "#6b7280",
  },
  groupHeaderMenu: {
    paddingHorizontal: 2,
  },
  errorBar: {
    backgroundColor: "#fef2f2",`,
  "archive styles",
  listRel2,
)

save(listRel2, screen)
console.log(listRel2 + ": archive view, per-chat actions, per-project bulk action")

// --- i18n --------------------------------------------------------------------

const STRINGS = {
  en: {
    badge: "archived",
    active: "Active",
    archived: "Archive",
    empty: "No archived chats",
    archiveChat: "Archive chat",
    restoreChat: "Restore chat",
    share: "Share transcript",
    copy: "Copy transcript",
    archiveProject: "Archive project",
    restoreProject: "Restore project",
    confirmTitle: "{{verb}}?",
    confirmMessage: "Chats affected: {{count}}.",
    partialTitle: "Finished with errors",
    partialMessage: "Done: {{done}}, failed: {{failed}}.",
    unsupportedTitle: "Not available on this server",
    unsupportedMessage:
      "This server's v2 API has no endpoint for archiving chats. Archiving works on opencode 1.x servers.",
    copiedTitle: "Transcript copied",
    copiedMessage: "The conversation is on the clipboard.",
    exportFailedTitle: "Export failed",
    exportFailedMessage: "Could not fetch the conversation from the server.",
    roleUser: "You",
    roleAssistant: "Assistant",
    project: "Project",
    updated: "Updated",
  },
  ru: {
    badge: "в архиве",
    active: "Активные",
    archived: "Архив",
    empty: "В архиве пока пусто",
    archiveChat: "В архив",
    restoreChat: "Из архива",
    share: "Поделиться перепиской",
    copy: "Скопировать переписку",
    archiveProject: "Архивировать проект",
    restoreProject: "Восстановить проект",
    confirmTitle: "«{{verb}}»?",
    confirmMessage: "Чатов затронуто: {{count}}.",
    partialTitle: "Завершено с ошибками",
    partialMessage: "Готово: {{done}}, с ошибкой: {{failed}}.",
    unsupportedTitle: "Сервер не поддерживает",
    unsupportedMessage:
      "В API v2 этого сервера нет эндпоинта для архивирования чатов. Архив работает на серверах opencode 1.x.",
    copiedTitle: "Переписка скопирована",
    copiedMessage: "Текст диалога в буфере обмена.",
    exportFailedTitle: "Не удалось выгрузить",
    exportFailedMessage: "Не получилось получить диалог с сервера.",
    roleUser: "Вы",
    roleAssistant: "Ассистент",
    project: "Проект",
    updated: "Обновлён",
  },
}

function group(strings) {
  return {
    badge: strings.badge,
    active: strings.active,
    archived: strings.archived,
    empty: strings.empty,
    actions: {
      archive: strings.archiveChat,
      restore: strings.restoreChat,
      share: strings.share,
      copy: strings.copy,
      archiveProject: strings.archiveProject,
      restoreProject: strings.restoreProject,
    },
    confirmTitle: strings.confirmTitle,
    confirmMessage: strings.confirmMessage,
    alerts: {
      partialTitle: strings.partialTitle,
      partialMessage: strings.partialMessage,
      unsupportedTitle: strings.unsupportedTitle,
      unsupportedMessage: strings.unsupportedMessage,
    },
  }
}

// en.json / zh-Hans.json ship upstream and are re-copied on every sync, so the
// keys are injected here; ru.json lives in this repo and is edited directly.
for (const [file, strings] of [
  ["en.json", STRINGS.en],
  ["zh-Hans.json", STRINGS.en],
]) {
  const rel = path.join("src", "lib", "i18n", file)
  const p = path.join(TARGET, rel)
  if (!fs.existsSync(p)) {
    console.error("not found: " + p)
    process.exit(1)
  }
  const json = JSON.parse(fs.readFileSync(p, "utf8"))
  if (!json.sessionsList) {
    console.error(rel + " patch FAILED: no sessionsList section")
    process.exit(1)
  }
  if (json.sessionsList.archive) continue
  const list = {}
  for (const [key, value] of Object.entries(json.sessionsList)) {
    list[key] = value
    // Keep the new block next to the other list-level actions.
    if (key === "actions") list.archive = group(strings)
  }
  if (!list.archive) list.archive = group(strings)
  json.sessionsList = list
  fs.writeFileSync(p, JSON.stringify(json, null, 2) + "\n")
  console.log(rel + ": sessionsList.archive added")
}
