const fs = require("fs")
const path = require("path")

// Fixes the chat markdown typography on Android: bold (`**...**`) runs overlap
// the neighbouring lines and the leading is far too tight.
//
// Why it happens: react-native-marked renders inline spans (strong / em / del /
// codespan) as *nested* <Text>. On Android a nested span that carries its own
// fontSize/lineHeight gets its own line box, and the library bakes its defaults
// (fontStyle.regular = 16/24) into every inline style. This app's theme only
// overrode the *weight*, never the metrics, so a bold span rendered at 16/24
// inside body text at 15/22 — a taller box on the same line, which Android
// paints over the neighbours (and clips the ascenders of "й"/"ё"). The
// paragraph wrapper itself is worse off: the library passes `{}` (not the
// theme's `text` style) to the node that wraps inline content, so plain
// paragraph text rendered with RN's 14pt default and no lineHeight at all.
//
// Fix: pin one set of metrics for every inline node (BASE_TEXT, applied in the
// custom renderer's plainText/br) and repeat them in the theme entries so the
// library's 16/24 defaults can't leak into a span.

const TARGET = process.argv[2]
if (!TARGET) {
  console.error("usage: node patch-markdown.js <repo-root>")
  process.exit(1)
}

const file = path.join(TARGET, "src", "components", "markdown", "Markdown.tsx")
if (!fs.existsSync(file)) {
  console.error("Markdown.tsx not found: " + file)
  process.exit(1)
}

let src = fs.readFileSync(file, "utf8")

function replaceOnce(haystack, needle, replacement, label) {
  const idx = haystack.indexOf(needle)
  if (idx === -1) {
    console.error("Markdown.tsx patch FAILED: marker not found: " + label)
    process.exit(1)
  }
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length)
}

// 1) One line box per line: every plain-text node gets the same metrics.
const baseText = `
// Every plain-text node gets the same metrics. react-native-marked renders
// inline spans (strong / em / del / codespan) as *nested* <Text>, and on
// Android a nested span whose fontSize/lineHeight differ from its parent's is
// laid out in its own, taller line box — which paints over the neighbouring
// lines and clips the ascenders of "й"/"ё". Pinning the base metrics on every
// node keeps one line box per line; the theme below still overrides them for
// headings and inline code.
const BASE_TEXT: TextStyle = { fontSize: 15, lineHeight: 22, includeFontPadding: true }

class CustomRenderer extends Renderer {`

src = replaceOnce(src, "class CustomRenderer extends Renderer {", baseText, "renderer class")

src = replaceOnce(
  src,
  `  private plainText(children: string | ReactNode[], styles?: StyleProp<TextStyle>): ReactNode {
    return (
      <Text key={this.getKey()} style={styles}>
        {children}
      </Text>
    )
  }`,
  `  private plainText(children: string | ReactNode[], styles?: StyleProp<TextStyle>): ReactNode {
    return (
      <Text key={this.getKey()} style={[BASE_TEXT, styles]}>
        {children}
      </Text>
    )
  }

  // The library's own \`br()\` goes through a private helper that drops the style
  // entirely, so a hard line break would fall back to RN's 14pt default line
  // box. Render it through plainText instead.
  br(): ReactNode {
    return this.plainText("\\n")
  }`,
  "plainText",
)

// 2) Theme: repeat the metrics on every inline entry so the library's 16/24
//    defaults can't survive the merge, and give headings a matching lineHeight.
src = replaceOnce(
  src,
  `  h1: { fontSize: 22, fontWeight: "700" as const, color: "#0a0a0a", marginBottom: 8, marginTop: 12 },
  h2: { fontSize: 19, fontWeight: "600" as const, color: "#0a0a0a", marginBottom: 6, marginTop: 10 },
  h3: { fontSize: 16, fontWeight: "600" as const, color: "#0a0a0a", marginBottom: 4, marginTop: 8 },
  link: { color: "#8b5cf6" },`,
  `  h1: { fontSize: 22, lineHeight: 28, fontWeight: "700" as const, color: "#0a0a0a", marginBottom: 8, marginTop: 12 },
  h2: { fontSize: 19, lineHeight: 26, fontWeight: "600" as const, color: "#0a0a0a", marginBottom: 6, marginTop: 10 },
  h3: { fontSize: 16, lineHeight: 22, fontWeight: "600" as const, color: "#0a0a0a", marginBottom: 4, marginTop: 8 },
  link: { color: "#8b5cf6", fontSize: 15, lineHeight: 22 },`,
  "headings/link",
)

src = replaceOnce(
  src,
  `  codespan: {
    backgroundColor: "#e8e5f0",
    color: "#6d28d9",
    fontFamily: mono,
    fontSize: 13,
    paddingHorizontal: 4,`,
  `  codespan: {
    backgroundColor: "#e8e5f0",
    color: "#6d28d9",
    fontFamily: mono,
    fontSize: 13,
    lineHeight: 20,
    paddingHorizontal: 4,`,
  "codespan",
)

src = replaceOnce(
  src,
  `  list: { marginBottom: 4 },
  li: { marginBottom: 2 },`,
  `  list: { marginBottom: 4 },
  li: { marginBottom: 2, fontSize: 15, lineHeight: 22 },`,
  "list item",
)

src = replaceOnce(
  src,
  `  strong: { fontWeight: "700" as const },
  em: { fontStyle: "italic" as const },
  strikethrough: { textDecorationLine: "line-through" as const },`,
  `  strong: { fontWeight: "700" as const, fontSize: 15, lineHeight: 22 },
  em: { fontStyle: "italic" as const, fontSize: 15, lineHeight: 22 },
  strikethrough: { textDecorationLine: "line-through" as const, fontSize: 15, lineHeight: 22 },`,
  "emphasis",
)

fs.writeFileSync(file, src)
console.log("Markdown.tsx: inline metrics pinned (no more bold overlap)")

// 3) Same complaint one screen over: the collapsible reasoning/summary block.
//    13pt over a 20px line box is tight enough that its own ascenders touch
//    the line above; 22 gives the body text the same rhythm.
const reasoning = path.join(TARGET, "src", "components", "chat", "ReasoningBlock.tsx")
if (!fs.existsSync(reasoning)) {
  console.error("ReasoningBlock.tsx not found: " + reasoning)
  process.exit(1)
}

let rsrc = fs.readFileSync(reasoning, "utf8")
const idx = rsrc.indexOf("  text: { fontSize: 13, lineHeight: 20, color: \"#78350f\", marginTop: 8 },")
if (idx === -1) {
  console.error("ReasoningBlock.tsx patch FAILED: marker not found: text style")
  process.exit(1)
}
rsrc =
  rsrc.slice(0, idx) +
  '  text: { fontSize: 13, lineHeight: 21, color: "#78350f", marginTop: 8 },' +
  rsrc.slice(idx + '  text: { fontSize: 13, lineHeight: 20, color: "#78350f", marginTop: 8 },'.length)

fs.writeFileSync(reasoning, rsrc)
console.log("ReasoningBlock.tsx: lineHeight 20 -> 21")
