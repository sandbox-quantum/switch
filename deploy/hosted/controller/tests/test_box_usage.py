"""The box scaler's usage report: the metrics API's quantities read as millicores and bytes, with the pod's limits."""

from __future__ import annotations

from switch_hosted_controller.box_scaler import box_usage

POD = {
    "spec": {
        "containers": [
            {"name": "controller", "resources": {"limits": {"cpu": "1", "memory": "1Gi"}}},
            {"name": "agents", "resources": {"limits": {"cpu": "3", "memory": "5376Mi"}}},
        ]
    }
}


class FakeKube:
    def __init__(self, metrics):
        self.metrics = metrics

    def box_metrics(self, namespace: str):
        return self.metrics


def test_usage_sums_the_containers_and_reads_the_limits() -> None:
    kube = FakeKube(
        {
            "containers": [
                {"name": "controller", "usage": {"cpu": "12345678n", "memory": "200Mi"}},
                {"name": "agents", "usage": {"cpu": "2900m", "memory": "1048576Ki"}},
            ]
        }
    )
    assert box_usage(kube, "agents-box-k1-0123456789abcdef", [POD]) == {
        "cpu_millicores": 2912,
        "memory_bytes": 200 * 2**20 + 2**30,
        "cpu_limit_millicores": 4000,
        "memory_limit_bytes": 2**30 + 5376 * 2**20,
    }


def test_no_metrics_or_an_unreadable_quantity_reports_nothing() -> None:
    assert box_usage(FakeKube(None), "ns", [POD]) is None
    assert (
        box_usage(
            FakeKube({"containers": [{"usage": {"cpu": "lots", "memory": "1Mi"}}]}), "ns", [POD]
        )
        is None
    )
    assert box_usage(object(), "ns", [POD]) is None
