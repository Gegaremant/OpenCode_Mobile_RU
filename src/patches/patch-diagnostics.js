const fs = require("fs")
const path = require("path")

// Connection diagnostics: stop reporting "OK" for a server we cannot talk to.
//
// The report is what the user pastes when a connect attempt fails, so a wrong
// verdict here costs hours: it says the connection works while every request
// fails. Two concrete defects, both visible on a v2 (opencode 2.x) server:
//
//   * The only server probe is GET /global/health, a v1-only route. On a v2
//     server it is not a route at all, so it falls through to the web SPA and
//     answers 200 text/html. `timedFetch` recorded `ok: res.ok` and nothing
//     else, so that HTML counted as a healthy health endpoint and the report
//     claimed "Health endpoint responded — connection actually works now."
//
//   * Nothing in the report says which API generation answered, so the one
//     fact that decides the next move — is this a v1 or a v2 server? — is not
//     collected at all.
//
// The fix is additive: `classify()` keeps its signature and its existing
// verdicts, and a new `classifyGeneration()` runs first and only overrides when
// it recognises a v2-shaped answer. That keeps every upstream classify test
// green while making the common v2 case tell the truth.

const TARGET = process.argv[2]
if (!TARGET) {
  console.error("usage: node patch-diagnostics.js <repo-root>")
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

// --- src/lib/diagnostics-classify.ts ------------------------------------------

const classifyRel = "src/lib/diagnostics-classify.ts"
let classifySrc = read(classifyRel)

classifySrc = replaceOnce(
  classifySrc,
  `  | "tls-error"
  | "timeout"
  | "unknown"`,
  `  | "tls-error"
  | "timeout"
  | "unknown"
  // The server answered, but with the web SPA instead of an API payload: it is
  // an opencode 2.x server, whose API lives under /api/ and has no
  // /global/health route.
  | "v2-api"`,
  "Classification union",
  classifyRel,
)

classifySrc = replaceOnce(
  classifySrc,
  `export interface ProbeAttempt {
  name: string
  target: string
  ok: boolean
  status?: number
  durationMs: number
  error?: string
  errorCause?: string
}`,
  `export interface ProbeAttempt {
  name: string
  target: string
  ok: boolean
  status?: number
  durationMs: number
  error?: string
  errorCause?: string
  // Needed to tell a real API payload from the web SPA. Both answer 200: the
  // SPA is exactly what an unknown route returns on both server generations,
  // so status alone cannot distinguish "healthy" from "not a route at all".
  contentType?: string
}

function served(a: ProbeAttempt): boolean {
  return a.ok && a.status != null && a.status < 300
}

function isJson(a: ProbeAttempt): boolean {
  return (a.contentType ?? "").includes("application/json")
}

/**
 * Decide the server's API generation before the generic classifier runs, and
 * override its verdict when the probes show a v2 server.
 *
 * /global/health is the discriminating route: it is registered on v1 (JSON
 * {healthy, version}) and unknown on v2, where it answers the SPA's HTML. So a
 * 2xx on it that is *not* JSON is positive evidence of a v2 server — and
 * positive evidence that this client cannot reach it over /global/health.
 *
 * Returns undefined to defer to \`classify()\`.
 */
export function classifyGeneration(
  health: ProbeAttempt,
  apiInfo: ProbeAttempt,
): { classification: Classification; summary: string } | undefined {
  if (served(health) && !isJson(health)) {
    const why =
      served(apiInfo) && isJson(apiInfo)
        ? "The server does serve the v2 API at /api/info, so this client failed for another reason."
        : "Its API lives under /api/ and it has no /global/health route."
    return {
      classification: "v2-api",
      summary:
        \`This is an opencode 2.x server (v2 API): \${why} \` +
        "A 200 from /global/health here is the web page, not a health check, so it does not mean the app can connect. " +
        "Check that the app build speaks v2 (see the APK bundle check in CI) and that the password is correct.",
    }
  }
  // A JSON /global/health is a healthy v1 server: classify() already says "ok".
  // A JSON /api/info is a healthy v2 server reached over a route v1 does not
  // have, so nothing here is wrong with the network.
  if (served(apiInfo) && isJson(apiInfo)) {
    return { classification: "ok", summary: "The server answered the v2 API at /api/info — the connection works." }
  }
  return undefined
}`,
  "classifyGeneration",
  classifyRel,
)

save(classifyRel, classifySrc)
console.log(classifyRel + ": classifyGeneration() added, contentType recorded on probes")

// --- src/lib/diagnostics.ts ----------------------------------------------------

const diagRel = "src/lib/diagnostics.ts"
let diag = read(diagRel)

diag = replaceOnce(
  diag,
  'import { type Classification, type ProbeAttempt, type ParsedUrl, parseUrl, classify } from "./diagnostics-classify"',
  'import { type Classification, type ProbeAttempt, type ParsedUrl, parseUrl, classify, classifyGeneration } from "./diagnostics-classify"',
  "diagnostics-classify import",
  diagRel,
)

diag = replaceOnce(
  diag,
  `    return { name, target, ok: requireOk ? res.ok : true, status: res.status, durationMs: Date.now() - start }`,
  `    return {
      name,
      target,
      ok: requireOk ? res.ok : true,
      status: res.status,
      durationMs: Date.now() - start,
      contentType: res.headers.get("content-type") ?? "",
    }`,
  "timedFetch result",
  diagRel,
)

diag = replaceOnce(
  diag,
  `  let health: ProbeAttempt
  let root: ProbeAttempt
  let internet: ProbeAttempt

  if (parsed.valid) {
    const base = \`\${parsed.scheme}://\${parsed.host}:\${parsed.port}\`
    ;[health, root, internet] = await Promise.all([
      timedFetch("health", \`\${base}/global/health\`, { headers }),
      timedFetch("server-root", \`\${base}/\`, { headers }, { requireOk: false }),
      timedFetch("internet", INTERNET_CHECK_URL),
    ])
  } else {
    const skipped: ProbeAttempt = { name: "health", target: url, ok: false, durationMs: 0, error: "skipped: malformed url" }
    health = skipped
    root = { ...skipped, name: "server-root" }
    internet = await timedFetch("internet", INTERNET_CHECK_URL)
  }`,
  `  let health: ProbeAttempt
  let root: ProbeAttempt
  let internet: ProbeAttempt
  let apiInfo: ProbeAttempt

  if (parsed.valid) {
    const base = \`\${parsed.scheme}://\${parsed.host}:\${parsed.port}\`
    ;[health, root, internet, apiInfo] = await Promise.all([
      timedFetch("health", \`\${base}/global/health\`, { headers }),
      timedFetch("server-root", \`\${base}/\`, { headers }, { requireOk: false }),
      timedFetch("internet", INTERNET_CHECK_URL),
      // The v2 identity route. Probing it is what lets the report say which
      // API generation answered instead of guessing from a 200 that may be
      // the web SPA.
      timedFetch("api-info", \`\${base}/api/info\`, { headers }),
    ])
  } else {
    const skipped: ProbeAttempt = { name: "health", target: url, ok: false, durationMs: 0, error: "skipped: malformed url" }
    health = skipped
    root = { ...skipped, name: "server-root" }
    apiInfo = { ...skipped, name: "api-info" }
    internet = await timedFetch("internet", INTERNET_CHECK_URL)
  }`,
  "probe list",
  diagRel,
)

diag = replaceOnce(
  diag,
  `  const { classification, summary } = classify(parsed, health, internet, root)`,
  `  // Generation first: on a v2 server the generic classifier would see a 2xx
  // from /global/health and report a healthy connection it cannot actually use.
  const generation = classifyGeneration(health, apiInfo)
  const { classification, summary } = generation ?? classify(parsed, health, internet, root)`,
  "classify call",
  diagRel,
)

diag = replaceOnce(diag, `    attempts: [health, root, internet],`, `    attempts: [health, root, internet, apiInfo],`, "attempts list", diagRel)

save(diagRel, diag)
console.log(diagRel + ": /api/info probed, generation checked before the generic verdict")

// --- src/lib/diagnostics-generation.test.ts ------------------------------------

const TEST = `import assert from "node:assert/strict"
import { test } from "node:test"

import { classifyGeneration, type ProbeAttempt } from "./diagnostics-classify.ts"

const SPA = { status: 200, contentType: "text/html" }

function probe(over: Partial<ProbeAttempt>): ProbeAttempt {
  return { name: "p", target: "t", ok: true, durationMs: 1, ...over }
}

// Recorded 2026-10-01 against opencode.gegaremant.ru (v2 server):
// /global/health answered 200 text/html — the web SPA, because the route does
// not exist there — while /api/info answered 401 application/json. The report
// built from the first of those claimed the connection worked.
test("a 2xx /global/health that is HTML means a v2 server, not a healthy one", () => {
  const verdict = classifyGeneration(probe(SPA), probe({ ok: false, status: 401, contentType: "application/json" }))
  assert.equal(verdict?.classification, "v2-api")
  assert.match(verdict?.summary ?? "", /opencode 2\\.x server/)
})

test("the v2 verdict names the route that actually answered", () => {
  const verdict = classifyGeneration(
    probe(SPA),
    probe({ ok: true, status: 200, contentType: "application/json" }),
  )
  assert.equal(verdict?.classification, "v2-api")
  assert.match(verdict?.summary ?? "", /does serve the v2 API/)
})

test("a JSON /global/health is a healthy v1 server and defers to classify()", () => {
  const verdict = classifyGeneration(
    probe({ ok: true, status: 200, contentType: "application/json" }),
    probe(SPA),
  )
  assert.equal(verdict, undefined)
})

test("a JSON /api/info is a healthy v2 server", () => {
  const verdict = classifyGeneration(
    probe({ ok: false, status: 401 }),
    probe({ ok: true, status: 200, contentType: "application/json" }),
  )
  assert.equal(verdict?.classification, "ok")
  assert.match(verdict?.summary ?? "", /v2 API at \\/api\\/info/)
})

test("rejected credentials on both routes defer to the auth-failed verdict", () => {
  const verdict = classifyGeneration(probe({ ok: false, status: 401 }), probe({ ok: false, status: 401 }))
  assert.equal(verdict, undefined)
})
`

const testFile = path.join(TARGET, "src", "lib", "diagnostics-generation.test.ts")
if (fs.existsSync(testFile)) {
  console.error("patch-diagnostics: refusing to overwrite existing diagnostics-generation.test.ts")
  process.exit(1)
}
fs.writeFileSync(testFile, TEST)
console.log("src/lib/diagnostics-generation.test.ts: v2 detection pinned")