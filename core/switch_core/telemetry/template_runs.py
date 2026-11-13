"""A template run, as `template_run` reports it.

Which template it was (one that comes with Switch by its slug, one saved
here, or a document the server cannot vouch for), who ran it, how old their
account was, and what the run made or why it made nothing. Never the
template's name, its document or its inputs.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

from switch_core.official_templates import is_official, slug_of
from switch_core.telemetry.ages import age_days
from switch_core.telemetry.service import TelemetryService, emit_safely

if TYPE_CHECKING:
    from switch_core.template_installs import InstallSource

TemplateRunner = Literal["person", "agent"]


def rooms_in(result: Mapping[str, Any] | None) -> int:
    """How many rooms a provisioning result made: a group's, one room's, or
    none for a run with no room half."""
    if result is None:
        return 0
    if "rooms" in result:
        return len(result["rooms"])
    return 1 if "room_id" in result else 0


# An agent's refusal, as a run failure: the run's own reasons and the two a
# person's run also has; every other refusal is reported by its own reason on
# `agent_request_refused`.
_REFUSAL_FAILURES = frozenset(
    {"agents_not_created", "run_undone", "invalid", "not_found"}
)


def failure_for_refusal(reason: str) -> str:
    """A refused agent run's reason."""
    return reason if reason in _REFUSAL_FAILURES else "refused"


def failure_for_status(status: int) -> str:
    """A refused run's reason, from the status a person's run answered."""
    return {
        400: "invalid",
        403: "forbidden",
        404: "not_found",
        409: "channel_in_use",
        502: "bridge_unavailable",
    }.get(status, "error")


@dataclass(frozen=True)
class TemplateRunReport:
    """One run, reported once it has made something or failed to."""

    telemetry: TelemetryService | None
    source: InstallSource | None
    runner: TemplateRunner
    account_created_at: object

    def _emit(
        self, *, agents_created: int, rooms_created: int, failure_reason: str
    ) -> None:
        source = self.source
        official = source is not None and is_official(source.template_id)
        emit_safely(
            self.telemetry,
            "template_run",
            {
                "source": "document" if source is None else source.source,
                "official_slug": slug_of(source.template_id)
                if source is not None and official
                else "none",
                "runner": self.runner,
                "agents_created": agents_created,
                "rooms_created": rooms_created,
                "account_age_days": age_days(self.account_created_at),
                "outcome": "success" if failure_reason == "none" else "failure",
                "failure_reason": failure_reason,
            },
        )

    def succeeded(self, *, agents_created: int, rooms_created: int) -> None:
        self._emit(
            agents_created=agents_created,
            rooms_created=rooms_created,
            failure_reason="none",
        )

    def failed(self, reason: str) -> None:
        self._emit(agents_created=0, rooms_created=0, failure_reason=reason)
