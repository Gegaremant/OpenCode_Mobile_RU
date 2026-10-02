#!/usr/bin/env python3
"""Turn an opencode session export into readable Markdown.

Usage:
    opencode api get /api/experimental/session/<id>/export > /tmp/sess.json
    python3 scripts/session-to-markdown.py /tmp/sess.json > SESSION.md

The export uses the v2 message schema: `type` instead of `role`, and an
assistant message carries a `content[]` array of reasoning / text / tool parts
rather than `parts[]`. Tool calls are kept but collapsed into a single detail
block per call — this is a transcript for reading, not a replay.
"""

import json
import sys


def fence(text, lang=""):
    """Wrap in a fence, widening it if the body contains one already."""
    text = "" if text is None else str(text)
    longest = 0
    run = 0
    for ch in text:
        run = run + 1 if ch == "`" else 0
        longest = max(longest, run)
    ticks = "`" * max(3, longest + 1)
    return f"{ticks}{lang}\n{text}\n{ticks}"


def as_json(value):
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, indent=2)


def tool_line(part):
    name = part.get("name") or part.get("id") or "tool"
    state = part.get("state") or {}
    status = state.get("status", "?")
    title = state.get("title") or state.get("metadata", {}).get("title") or ""
    head = f"`{name}` — {status}"
    if title and title != name:
        head += f" — {title}"
    body = []
    if state.get("input") is not None:
        body.append("**input**\n\n" + fence(as_json(state["input"]), "json"))
    if state.get("error"):
        body.append("**error**\n\n" + fence(as_json(state["error"]), "json"))
    elif state.get("output") is not None:
        body.append("**output**\n\n" + fence(as_json(state["output"])))
    elif state.get("content") is not None:
        body.append("**content**\n\n" + fence(as_json(state["content"])))
    return head, "\n\n".join(body)


def render(msg):
    kind = msg.get("type")
    out = []

    if kind == "user":
        text = msg.get("text") or msg.get("metadata", {}).get("displayText") or ""
        for f in msg.get("files") or []:
            text += f"\n\n_(attachment: {f.get('name') or f.get('uri')})_"
        out.append(f"### You\n\n{text.strip()}")
        return "\n\n".join(out)

    if kind == "assistant":
        out.append("### Assistant")
        for part in msg.get("content") or []:
            ptype = part.get("type")
            if ptype == "text":
                out.append(part.get("text", "").strip())
            elif ptype == "reasoning":
                text = part.get("text", "").strip()
                if text:
                    out.append(f"<details><summary>reasoning</summary>\n\n{text}\n\n</details>")
            elif ptype == "tool":
                head, body = tool_line(part)
                out.append(f"<details><summary>{head}</summary>\n\n{body}\n\n</details>")
        blocks = [b for b in out[1:] if b]
        return out[0] + ("\n\n" + "\n\n".join(blocks) if blocks else "")

    if kind == "system":
        return f"### System\n\n{as_json(msg.get('content') or msg.get('text') or msg)}"

    if kind == "synthetic":
        return f"### Synthetic\n\n{(msg.get('text') or '').strip()}"

    if kind == "idle":
        return None

    return f"### {kind}\n\n" + fence(as_json(msg), "json")


def main():
    raw = json.load(open(sys.argv[1], encoding="utf-8"))
    data = raw.get("data", raw)
    info = data.get("info", {})

    print(f"# {info.get('title', 'Session')}\n")
    print(f"- **Session**: `{info.get('id', '?')}`")
    print(f"- **Directory**: `{info.get('location', {}).get('directory', '?')}`")
    tokens = info.get("tokens") or {}
    print(
        f"- **Messages**: {len(data.get('messages', []))}"
        f"  ·  tokens in {tokens.get('input', 0):,} / out {tokens.get('output', 0):,}"
    )
    print()

    for msg in data.get("messages", []):
        block = render(msg)
        if block:
            print(block)
            print("\n---\n")


if __name__ == "__main__":
    main()