"""Reading a template's YAML so that the work it costs is bounded by its size.

PyYAML builds an alias (``*name``) as a second reference to the anchored
(``&name``) value, so a few hundred bytes of nested aliases parse at once into
a structure that every walk over it (interpolation, validation, linting)
visits billions of times, holding the event loop the whole while. A template
has no need for shared structure, so an anchor or alias is refused while the
document is composed, before any Python object exists. The document's length
and its number of values are capped too.

Every reading of a template someone sent goes through ``load_template_yaml``.
The refusal is a ``yaml.YAMLError``, so callers that already report a document
that does not parse report this the same way, with its line and column.
"""

from __future__ import annotations

from typing import Any

import yaml

# Room and agent templates run to a few thousand characters and a few hundred
# values; the largest that come with Switch are about 11,000 and 200.
MAX_TEMPLATE_CHARS = 256 * 1024
MAX_TEMPLATE_NODES = 10_000


class TemplateYamlRefused(yaml.MarkedYAMLError):
    """A template Switch will not read: it uses anchors or aliases, or it is
    larger than a template may be."""


class _TemplateLoader(yaml.SafeLoader):
    def __init__(self, stream: str) -> None:
        super().__init__(stream)
        self._nodes = 0

    def compose_node(self, parent: Any, index: Any) -> Any:
        event = self.peek_event()
        if isinstance(event, yaml.AliasEvent) or event.anchor is not None:
            raise TemplateYamlRefused(
                problem=(
                    "a template cannot use YAML anchors or aliases "
                    f"(&{event.anchor} / *{event.anchor}); write the value out "
                    "in full everywhere it is used"
                ),
                problem_mark=event.start_mark,
            )
        self._nodes += 1
        if self._nodes > MAX_TEMPLATE_NODES:
            raise TemplateYamlRefused(
                problem=(
                    f"a template may hold at most {MAX_TEMPLATE_NODES:,} values, "
                    "and this one holds more"
                ),
                problem_mark=event.start_mark,
            )
        return super().compose_node(parent, index)


def load_template_yaml(text: str) -> Any:
    """``yaml.safe_load`` for a template: the same result for any document
    without anchors, aliases or excess size, and ``TemplateYamlRefused`` for
    one with them."""
    if len(text) > MAX_TEMPLATE_CHARS:
        raise TemplateYamlRefused(
            problem=(
                f"the template is {len(text):,} characters long, and a template "
                f"may be at most {MAX_TEMPLATE_CHARS:,}"
            )
        )
    loader = _TemplateLoader(text)
    try:
        return loader.get_single_data()
    finally:
        loader.dispose()
