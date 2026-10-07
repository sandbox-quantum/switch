#!/usr/bin/python3
"""A fake EC2 instance metadata service (IMDSv2) on 169.254.169.254:80.

It serves the session token, the instance id, and placeholder IAM role
credentials, which the controller's KMS client and boto3 pick up and moto
accepts. Every metadata read must carry a token from PUT /latest/api/token.
"""

import json
import secrets
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

INSTANCE_ID = "i-0123456789abcdef0"
ROLE = "cc-gate-machine-role"
REGION = "us-east-1"
TOKENS: set[str] = set()


def credentials() -> dict:
    now = datetime.now(UTC)
    return {
        "Code": "Success",
        "LastUpdated": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "Type": "AWS-HMAC",
        "AccessKeyId": "ASIAGATEPLACEHOLDER0",
        "SecretAccessKey": "gate-placeholder-secret-not-real",
        "Token": "gate-placeholder-session-token",
        "Expiration": (now + timedelta(hours=6)).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


class Handler(BaseHTTPRequestHandler):
    def reply(self, status: int, body: str, kind: str = "text/plain") -> None:
        data = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_PUT(self) -> None:
        if self.path != "/latest/api/token":
            return self.reply(404, "not found")
        token = secrets.token_urlsafe(24)
        TOKENS.add(token)
        self.reply(200, token)

    def do_GET(self) -> None:
        if self.headers.get("X-aws-ec2-metadata-token") not in TOKENS:
            return self.reply(401, "missing or unknown IMDSv2 token")
        path = self.path.rstrip("/")
        if path == "/latest/meta-data/instance-id":
            return self.reply(200, INSTANCE_ID)
        if path == "/latest/meta-data/placement/region":
            return self.reply(200, REGION)
        if path in (
            "/latest/meta-data/iam/security-credentials",
            "/latest/meta-data/iam/security-credentials-extended",
        ):
            return self.reply(200, ROLE)
        if path in (
            f"/latest/meta-data/iam/security-credentials/{ROLE}",
            f"/latest/meta-data/iam/security-credentials-extended/{ROLE}",
        ):
            return self.reply(200, json.dumps(credentials()), "application/json")
        if path == "/latest/dynamic/instance-identity/document":
            return self.reply(
                200,
                json.dumps(
                    {
                        "instanceId": INSTANCE_ID,
                        "region": REGION,
                        "accountId": "123456789012",
                    }
                ),
                "application/json",
            )
        self.reply(404, "not found")

    def log_message(self, format: str, *args: object) -> None:
        print("imds:", format % args, flush=True)


ThreadingHTTPServer(("169.254.169.254", 80), Handler).serve_forever()
