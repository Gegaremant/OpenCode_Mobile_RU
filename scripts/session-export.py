#!/usr/bin/env python3
"""Export an opencode session as Markdown + YAML.

Usage (normally called by backup-session.sh):

    python3 scripts/session-export.py --out-dir . [--session <id>] [--all]

Resolves which session(s) to export, pulls the full transcript from
`opencode api get /api/experimental/session/<id>/export`, and writes two files
per session:

    yy-mm-dd_<slug>_session.md     readable transcript
    yy-mm-dd_<slug>_session.yaml   structured data

Session selection, in order of precedence:
  --session <id>   that exact session
  --all            every session rooted at this directory
  (default)        the most recently updated session rooted at this directory

The export uses the v2 message schema — `type` rather than `role`, and an
assistant message carrying `content[]` of reasoning/text/tool parts instead of
`parts[]`.
"""

import argparse
import datetime
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load_render():
    """Import the Markdown renderer next to this file (its name has a dash)."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("session_to_markdown", HERE / "session-to-markdown.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def api(path):
    """Call the running server through the CLI, so auth and discovery match.

    stdout goes to a temp file rather than a pipe: `opencode api get` produces
    megabytes for a long session, and reading it back through a pipe truncates
    the JSON mid-string. Redirecting to a file returns the whole body.
    """
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tmp:
        out = Path(tmp.name)
    try:
        with open(out, "w", encoding="utf-8") as handle:
            proc = subprocess.run(["opencode", "api", "get", path], stdout=handle, stderr=subprocess.PIPE, text=True)
        if proc.returncode != 0:
            raise SystemExit(f"opencode api get {path} failed:\n{proc.stderr.strip()}")
        return json.loads(out.read_text(encoding="utf-8"))
    finally:
        out.unlink(missing_ok=True)


def slug(text, limit=48):
    text = re.sub(r"[\r\n\t]+", " ", text or "").strip()
    text = re.sub(r"[^0-9A-Za-zЀ-ӿ _.-]", "", text)
    text = re.sub(r"\s+", "_", text).strip("._-")
    return (text[:limit].rstrip("._-") or "session")


def sessions_in(directory):
    raw = api("/api/session")
    rows = raw if isinstance(raw, list) else raw.get("data", [])
    here = str(directory)
    mine = [
        s
        for s in rows
        if s.get("location", {}).get("directory") == here or s.get("directory") == here
    ]
    return sorted(mine, key=lambda s: s.get("time", {}).get("updated", 0), reverse=True)


def to_yaml_block(payload):
    import yaml

    return yaml.safe_dump(payload, allow_unicode=True, sort_keys=False, width=100)


def message_index(messages):
    """Compact per-message record for the YAML: enough to search and re-slice."""
    out = []
    for msg in messages:
        kind = msg.get("type", "?")
        entry = {
            "id": msg.get("id"),
            "type": kind,
            "created": msg.get("time", {}).get("created"),
        }
        if kind == "user":
            entry["text"] = msg.get("text") or msg.get("metadata", {}).get("displayText") or ""
            entry["attachments"] = [f.get("name") or f.get("uri") for f in msg.get("files") or []]
        elif kind == "assistant":
            tools, texts = [], []
            for part in msg.get("content") or []:
                if part.get("type") == "text":
                    texts.append(part.get("text", ""))
                elif part.get("type") == "tool":
                    tools.append(
                        {
                            "name": part.get("name"),
                            "status": (part.get("state") or {}).get("status"),
                            "error": (part.get("state") or {}).get("error"),
                        }
                    )
            entry["model"] = msg.get("model")
            entry["finish"] = msg.get("finish")
            entry["tokens"] = msg.get("tokens")
            entry["text"] = "\n\n".join(t for t in texts if t.strip())
            entry["tools"] = tools
        elif kind in ("synthetic", "system"):
            entry["text"] = msg.get("text") or msg.get("content")
        elif kind == "idle":
            entry["outcome"] = msg.get("outcome")
        out.append(entry)
    return out


def write_session(session, out_dir, render):
    sid = session["id"]
    payload = api(f"/api/experimental/session/{sid}/export")
    data = payload.get("data", payload)
    info = data.get("info", {})

    created = info.get("time", {}).get("created") or session.get("time", {}).get("created")
    stamp = datetime.datetime.fromtimestamp(created / 1000).strftime("%y-%m-%d") if created else "unknown"
    base = f"{stamp}_{slug(info.get('title') or session.get('title') or 'session')}_session"

    md_path = out_dir / f"{base}.md"
    yml_path = out_dir / f"{base}.yaml"

    md = [f"# {info.get('title') or 'Session'}\n"]
    md.append(f"- **Session**: `{sid}`")
    md.append(f"- **Directory**: `{info.get('location', {}).get('directory', '?')}`")
    md.append(
        f"- **Messages**: {len(data.get('messages', []))}"
        f"  ·  tokens in {info.get('tokens', {}).get('input', 0):,}"
        f" / out {info.get('tokens', {}).get('output', 0):,}\n"
    )
    for msg in data.get("messages", []):
        block = render.render(msg)
        if block:
            md.append(block)
            md.append("\n---\n")
    md_path.write_text("\n".join(md), encoding="utf-8")

    document = {
        "info": {
            "id": info.get("id"),
            "title": info.get("title"),
            "directory": info.get("location", {}).get("directory"),
            "projectID": info.get("projectID"),
            "agent": info.get("agent"),
            "model": info.get("model"),
            "outcome": info.get("outcome"),
            "time": info.get("time"),
            "cost": info.get("cost"),
            "tokens": info.get("tokens"),
        },
        "exported_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "message_count": len(data.get("messages", [])),
        "messages": message_index(data.get("messages", [])),
    }
    yml_path.write_text(to_yaml_block(document), encoding="utf-8")

    return md_path, yml_path


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--session", help="export this session id")
    ap.add_argument("--all", action="store_true", help="export every session rooted at this directory")
    ap.add_argument("--out-dir", default=".", help="where to write the files (default: next to the caller)")
    args = ap.parse_args()

    out_dir = Path(args.out_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    render = load_render()

    if args.session:
        targets = [s for s in sessions_in(Path.cwd()) if s["id"] == args.session]
        if not targets:
            targets = api(f"/api/session/{args.session}")
            targets = [{"id": args.session, **(targets.get("data", targets) if isinstance(targets, dict) else {})}]
    elif args.all:
        targets = sessions_in(Path.cwd())
    else:
        targets = sessions_in(Path.cwd())[:1]

    if not targets:
        print("no sessions found for this directory", file=sys.stderr)
        return 1

    for session in targets:
        md_path, yml_path = write_session(session, out_dir, render)
        print(f"{md_path.name}  ({md_path.stat().st_size:,} bytes)")
        print(f"{yml_path.name}  ({yml_path.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())