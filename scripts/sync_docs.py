"""Sync the published Switch documentation into this repository as Markdown.

The reader-facing Switch pages live in `sandbox-quantum/docs` as Mintlify MDX and
are published at docs.switchagents.ai, which is where agents should read them
(https://docs.switchagents.ai/llms.txt, or the docs MCP server at
https://docs.switchagents.ai/mcp). The pages are also converted to plain Markdown and
committed here, as a copy for agents that cannot reach the site.

The output is generated. Edit the source pages in the docs repository and re-run
`just sync-docs`; anything written directly into the destination is lost on the
next run. A scheduled workflow (.github/workflows/docs-sync.yml) runs the sync
daily and opens a pull request when the published pages have changed.

`--check` renders the pages without touching the destination and exits 1 when the
committed copy differs from what the published docs would produce.
"""

import argparse
import json
import posixpath
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

DOCS_REPO_URL = "https://github.com/sandbox-quantum/docs"
PRODUCT = "Switch Rooms"
SOURCE_PREFIX = "switch-rooms/"
SITE_BASE = "https://docs.switchagents.ai"

# Components whose body is kept and whose wrapper is dropped.
TRANSPARENT = {
    "Steps",
    "AccordionGroup",
    "CardGroup",
    "CodeGroup",
    "Tabs",
    "Columns",
    "Frame",
    "Update",
}

# Components rendered as a bold lead followed by their body.
CALLOUTS = {
    "Note": "Note",
    "Tip": "Tip",
    "Warning": "Warning",
    "Info": "Info",
    "Check": "Check",
    "Danger": "Danger",
}

# Components collapsed into a single line, body and all.
CAPTURED = {"Card"}

# Components whose `title` attribute becomes a heading.
TITLED = {"Step": "###", "Accordion": "###", "Tab": "###", "Expandable": "###"}

MDX_COMMENT = re.compile(r"\{/\*.*?\*/\}", re.DOTALL)
OPEN_TAG = re.compile(r"^(\s*)<([A-Z][A-Za-z]*)((?:\s[^>]*?)?)>\s*$")
CLOSE_TAG = re.compile(r"^(\s*)</([A-Z][A-Za-z]*)>\s*$")
SELF_CLOSING = re.compile(r"^(\s*)<([A-Z][A-Za-z]*)((?:\s[^>]*?)?)/>\s*$")
ONE_LINER = re.compile(r"^(\s*)<([A-Z][A-Za-z]*)((?:\s[^>]*?)?)>(.*)</\2>\s*$")
ATTR = re.compile(r'(\w[\w:-]*)\s*=\s*(?:"([^"]*)"|\{([^}]*)\})')


def attrs(raw: str) -> dict[str, str]:
    return {
        m.group(1): m.group(2) if m.group(2) is not None else m.group(3)
        for m in ATTR.finditer(raw or "")
    }


def split_frontmatter(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---\n", 4)
    if end == -1:
        return {}, text
    block, body = text[4:end], text[end + 5 :]
    meta: dict[str, str] = {}
    for line in block.splitlines():
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip().strip('"')
        value = value.strip()
        if value[:1] in {'"', "'"} and value[-1:] == value[:1] and len(value) > 1:
            value = value[1:-1]
        meta[key] = value
    return meta, body


def rewrite_link(target: str, from_dir: str = "") -> str:
    """Point an in-site link at the converted file, or at the published site."""
    path, _, anchor = target.partition("#")
    anchor = f"#{anchor}" if anchor else ""
    rel = path.lstrip("/")
    if not rel.startswith(SOURCE_PREFIX):
        return f"{SITE_BASE}/{rel}{anchor}"
    page = f"{rel[len(SOURCE_PREFIX) :] or 'index'}.md"
    return f"{posixpath.relpath(page, from_dir or '.')}{anchor}"


def rewrite_links(text: str, from_dir: str = "") -> str:
    text = re.sub(
        r"\]\((/[^)\s]+)\)", lambda m: f"]({rewrite_link(m.group(1), from_dir)})", text
    )
    return re.sub(
        r'href="(/[^"]+)"',
        lambda m: f'href="{rewrite_link(m.group(1), from_dir)}"',
        text,
    )


def convert_body(body: str, from_dir: str = "") -> str:
    body = MDX_COMMENT.sub("", body)
    out: list[str] = []
    # (tag, indent of the body inside it, attributes, collected body or None)
    stack: list[tuple[str, int, dict[str, str], list[str] | None]] = []
    in_fence = False

    for raw in body.splitlines():
        indent = stack[-1][1] if stack else 0
        line = raw[indent:] if raw[:indent].strip() == "" else raw.lstrip()
        sink = stack[-1][3] if stack else None

        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            (sink if sink is not None else out).append(line)
            continue
        if in_fence:
            (sink if sink is not None else out).append(line)
            continue

        if m := ONE_LINER.match(raw):
            _, tag, raw_attrs, inner = m.groups()
            out.append(render_inline(tag, attrs(raw_attrs), inner.strip(), from_dir))
            continue
        if m := SELF_CLOSING.match(raw):
            _, tag, raw_attrs = m.groups()
            out.append(render_inline(tag, attrs(raw_attrs), "", from_dir))
            continue
        if m := OPEN_TAG.match(raw):
            tag_indent, tag, raw_attrs = m.groups()
            if tag in CAPTURED:
                stack.append((tag, len(tag_indent) + 2, attrs(raw_attrs), []))
                continue
            if tag in TRANSPARENT or tag in CALLOUTS or tag in TITLED:
                lead = render_open(tag, attrs(raw_attrs))
                if lead:
                    out.extend(["", lead, ""])
                stack.append((tag, len(tag_indent) + 2, attrs(raw_attrs), None))
                continue
        if m := CLOSE_TAG.match(raw):
            if stack and stack[-1][0] == m.group(2):
                tag, _, a, body = stack.pop()
                if body is not None:
                    out.append(
                        render_inline(
                            tag, a, " ".join(x.strip() for x in body if x.strip())
                        )
                    )
                else:
                    out.append("")
                continue

        (sink if sink is not None else out).append(line)

    text = "\n".join(out)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip() + "\n"


def render_open(tag: str, a: dict[str, str]) -> str:
    if tag in CALLOUTS:
        return f"**{CALLOUTS[tag]}**"
    if tag in TITLED and a.get("title"):
        return f"{TITLED[tag]} {a['title']}"
    return ""


def render_inline(tag: str, a: dict[str, str], inner: str, from_dir: str = "") -> str:
    if tag == "Card":
        title = a.get("title", "").strip()
        href = a.get("href", "")
        body = f" — {inner}" if inner else ""
        return f"- [{title}]({href}){body}" if href else f"- **{title}**{body}"
    if tag in CALLOUTS:
        return f"**{CALLOUTS[tag]}** {inner}".rstrip()
    if tag in TITLED and a.get("title"):
        return f"{TITLED[tag]} {a['title']}\n\n{inner}".rstrip()
    return inner


def published_url(page: str) -> str:
    """The address this page is served at, so a reader can be sent to it."""
    return f"{SITE_BASE}/{page.removesuffix('/index')}"


def convert_page(source: Path, page: str, from_dir: str) -> str:
    meta, body = split_frontmatter(source.read_text(encoding="utf-8"))
    parts: list[str] = []
    if title := meta.get("title"):
        parts.append(f"# {title}\n")
    if description := meta.get("description"):
        parts.append(f"_{description}_\n")
    parts.append(
        f"Published at <{published_url(page)}> — link readers there, not to this file.\n"
    )
    parts.append(convert_body(rewrite_links(body, from_dir), from_dir))
    return "\n".join(parts)


def switch_pages(docs_json: dict) -> list[tuple[list[str], str]]:
    """Every Switch page in navigation order, as (group trail, page path)."""
    product = next(
        (p for p in docs_json["navigation"]["products"] if p.get("product") == PRODUCT),
        None,
    )
    if product is None:
        raise SystemExit(
            f"No {PRODUCT!r} product in docs.json — the navigation shape changed."
        )

    found: list[tuple[list[str], str]] = []

    def walk(node, trail: list[str]) -> None:
        if isinstance(node, str):
            found.append((trail, node))
        elif isinstance(node, list):
            for item in node:
                walk(item, trail)
        elif isinstance(node, dict):
            name = node.get("group")
            inner = trail + [name] if name else trail
            for key in ("groups", "pages", "tabs"):
                if key in node:
                    walk(node[key], inner)

    walk(product.get("groups", product.get("pages", [])), [])
    return found


def write_index(dest: Path, entries: list[tuple[list[str], str]]) -> None:
    lines = [
        "# Switch documentation",
        "",
        "The reader-facing Switch documentation, converted from the Mintlify source in",
        f"`sandbox-quantum/docs` and published at {SITE_BASE}.",
        "",
        f"Read the published docs when you can reach them: {SITE_BASE}/llms.txt lists",
        f"every page, and {SITE_BASE}/mcp serves them over MCP. This copy is for agents",
        "without network access and is refreshed by a daily sync, so it can trail the",
        "site by a day or so.",
        "",
        "Generated by `just sync-docs`. Do not edit these files: change the source pages",
        "in the docs repository and run the sync again.",
        "",
        "Each page carries the address it is published at. Send people to that address",
        "rather than to a path in this repository, which they cannot open.",
        "",
    ]
    current: list[str] = []
    for trail, page in entries:
        if trail != current:
            current = trail
            lines.extend(["", f"## {' › '.join(trail)}" if trail else "", ""])
        rel = page[len(SOURCE_PREFIX) :] or "index"
        lines.append(f"- [{rel}]({rel}.md) — <{published_url(page)}>")
    (dest / "TOC.md").write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def resolve_source(source: str | None, keep: Path) -> Path:
    if source:
        path = Path(source).expanduser().resolve()
        if not (path / "docs.json").is_file():
            raise SystemExit(
                f"{path} has no docs.json — is it a checkout of the docs repository?"
            )
        return path
    print(f"Cloning {DOCS_REPO_URL}", file=sys.stderr)
    subprocess.run(
        ["git", "clone", "--depth", "1", "--quiet", DOCS_REPO_URL, str(keep)],
        check=True,
    )
    return keep


def render(source: Path, dest: Path) -> tuple[int, list[str]]:
    """Write every Switch page from `source` into `dest`, which must be empty."""
    entries = switch_pages(
        json.loads((source / "docs.json").read_text(encoding="utf-8"))
    )
    written = 0
    missing: list[str] = []
    for _, page in entries:
        mdx = source / f"{page}.mdx"
        if not mdx.is_file():
            missing.append(page)
            continue
        rel = f"{page[len(SOURCE_PREFIX) :] or 'index'}.md"
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            convert_page(mdx, page, posixpath.dirname(rel)), encoding="utf-8"
        )
        written += 1
    write_index(dest, entries)
    return written, missing


def tree(root: Path) -> dict[str, bytes]:
    if not root.is_dir():
        return {}
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in root.rglob("*")
        if path.is_file()
    }


def stale_files(committed: Path, fresh: Path) -> list[str]:
    """Files that would be added (+), removed (-) or changed (~) by a sync."""
    old, new = tree(committed), tree(fresh)
    return [
        f"{'+' if name not in old else '-' if name not in new else '~'} {name}"
        for name in sorted(old.keys() | new.keys())
        if old.get(name) != new.get(name)
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        help="Path to a checkout of sandbox-quantum/docs. Cloned into a temporary directory when omitted.",
    )
    parser.add_argument(
        "--dest",
        default="docs/official",
        help="Directory to write the converted pages into. Replaced on every run.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Write nothing; exit 1 when the destination differs from the published docs.",
    )
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    dest = (repo_root / args.dest).resolve()
    where = dest.relative_to(repo_root) if dest.is_relative_to(repo_root) else dest

    with tempfile.TemporaryDirectory() as tmp:
        source = resolve_source(args.source, Path(tmp) / "docs")
        if args.check:
            fresh = Path(tmp) / "fresh"
            fresh.mkdir()
            written, missing = render(source, fresh)
            changed = stale_files(dest, fresh)
        else:
            if dest.exists():
                shutil.rmtree(dest)
            dest.mkdir(parents=True)
            written, missing = render(source, dest)

    if missing:
        print(
            f"Listed in navigation but absent from the source: {', '.join(missing)}",
            file=sys.stderr,
        )
    if not args.check:
        print(f"Wrote {written} pages to {where}")
        return 1 if missing else 0
    if changed:
        print(
            f"{where} is older than the published docs; run `just sync-docs`. "
            f"{len(changed)} file(s) differ:",
            file=sys.stderr,
        )
        print("\n".join(changed), file=sys.stderr)
        return 1
    print(f"{where} matches the published docs ({written} pages)")
    return 1 if missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
