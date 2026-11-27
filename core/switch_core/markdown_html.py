"""Markdown from a person or an agent, rendered as HTML a reader can trust.

Whoever wrote the text chose every link and image in it, so what Markdown
makes of it is cut back before it reaches a client: raw HTML is shown as text,
a link keeps its target only for the web, mail or Matrix, and an image is a
request to wherever the writer chose, from every client that shows it.
"""

from __future__ import annotations

import re
from xml.etree.ElementTree import Element

from markdown import Markdown
from markdown.treeprocessors import Treeprocessor

# The schemes a link may point at. Anything else, a relative link included,
# keeps its text and loses its target.
LINKABLE_SCHEMES = frozenset({"http", "https", "mailto", "matrix"})

_SCHEME_RE = re.compile(r"\A([a-z][a-z0-9+.\-]*):")


def url_scheme(url: str) -> str | None:
    """A URL's scheme as a browser would read it: case and blanks ignored."""
    cleaned = "".join(ch for ch in url if ch > " " and ch != "\x7f").lower()
    match = _SCHEME_RE.match(cleaned)
    return match.group(1) if match else None


class SafeLinks(Treeprocessor):
    """Take unsafe targets off what Markdown made of someone's text.

    Run on the element tree, after links and images exist as elements, so a
    link's title, a reference definition or the attribute order cannot get one
    past it. A link to anything but the web, mail or Matrix keeps its text. An
    image keeps only its description, unless `keep_mxc_images` lets one from
    Switch's own media store (`mxc://`) through, as Matrix clients expect.
    """

    def __init__(self, md: Markdown, *, keep_mxc_images: bool) -> None:
        super().__init__(md)
        self._keep_mxc_images = keep_mxc_images

    def run(self, root: Element) -> None:
        for element in root.iter():
            if (
                element.tag == "a"
                and url_scheme(element.get("href", "")) not in LINKABLE_SCHEMES
            ):
                element.tag = "span"
                element.attrib.clear()
            elif element.tag == "img":
                source = element.get("src", "")
                if self._keep_mxc_images and url_scheme(source) == "mxc":
                    # Written as clients expect it, whatever case it came in.
                    rest = source.strip().split(":", 1)[1]
                    element.set("src", f"mxc:{rest}")
                    continue
                description = element.get("alt", "")
                element.tag = "span"
                element.attrib.clear()
                element.text = description


def safe_markdown(extensions: list[str], *, keep_mxc_images: bool) -> Markdown:
    """A `Markdown` renderer with raw HTML off and `SafeLinks` applied."""
    renderer = Markdown(extensions=extensions)
    renderer.preprocessors.deregister("html_block")
    renderer.inlinePatterns.deregister("html")
    # After the inline pass (20), which is what turns links into elements.
    renderer.treeprocessors.register(
        SafeLinks(renderer, keep_mxc_images=keep_mxc_images), "safe-links", 5
    )
    return renderer
