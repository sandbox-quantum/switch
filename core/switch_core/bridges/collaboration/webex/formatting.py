from __future__ import annotations

from html.parser import HTMLParser
from urllib.parse import urlsplit


class _Markdown(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.links: list[str | None] = []
        self.pre = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "a":
            href = attributes.get("href") or ""
            try:
                safe = urlsplit(href).scheme in ("https", "http")
            except ValueError:
                safe = False
            self.links.append(href if safe else None)
            if safe:
                self.parts.append("[")
        elif tag in ("strong", "b"):
            self.parts.append("**")
        elif tag in ("em", "i"):
            self.parts.append("*")
        elif tag == "pre":
            self.pre = True
            self.parts.append("\n```\n")
        elif tag == "code" and not self.pre:
            self.parts.append("`")
        elif tag in ("p", "div", "br", "blockquote"):
            self.parts.append("\n")
            if tag == "blockquote":
                self.parts.append("> ")
        elif tag == "li":
            self.parts.append("\n- ")

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self.links:
            href = self.links.pop()
            if href:
                self.parts.append(f"]({href})")
        elif tag in ("strong", "b"):
            self.parts.append("**")
        elif tag in ("em", "i"):
            self.parts.append("*")
        elif tag == "pre":
            self.parts.append("\n```\n")
            self.pre = False
        elif tag == "code" and not self.pre:
            self.parts.append("`")
        elif tag in ("p", "div", "blockquote", "ul", "ol"):
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def from_html(content: str) -> str:
    parser = _Markdown()
    parser.feed(content)
    return "".join(parser.parts).strip()
