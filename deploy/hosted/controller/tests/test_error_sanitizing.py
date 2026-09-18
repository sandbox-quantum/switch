from botocore.exceptions import ClientError

from switch_hosted_controller.reconciler import _safe_error


def test_aws_error_code_is_reported_without_message_or_request_details():
    error = ClientError(
        {
            "Error": {
                "Code": "AccessDenied",
                "Message": "credential-value-must-not-appear",
            }
        },
        "RunInstances",
    )
    assert _safe_error(error) == "AWS request failed with AccessDenied"


def test_malformed_aws_error_code_is_not_echoed():
    error = ClientError(
        {"Error": {"Code": "AccessDenied: credential-value", "Message": "also-secret"}},
        "RunInstances",
    )
    rendered = _safe_error(error)
    assert rendered == "AWS request failed with an invalid error code"
    assert "credential" not in rendered
    assert "secret" not in rendered
