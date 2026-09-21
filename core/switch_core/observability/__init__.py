"""Operational observability: what this server reports about itself.

Structured logging already existed (:mod:`switch_core.logging_config` and
:mod:`switch_core.logging_context`); this package adds the measurements and the
path they leave by. Everything is off until ``OTLP_ENDPOINT`` names a
collector — see :class:`switch_core.config.SwitchConfig`.

Read :mod:`switch_core.observability.catalogue` before adding a metric: nothing
is emitted that is not declared there, attributes included.
"""

from switch_core.observability.metrics import (
    GaugeReading,
    MetricsRegistry,
    install,
    metrics,
    uninstall,
)

__all__ = [
    "GaugeReading",
    "MetricsRegistry",
    "install",
    "metrics",
    "uninstall",
]
