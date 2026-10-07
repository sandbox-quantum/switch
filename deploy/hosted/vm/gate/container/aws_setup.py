"""Creates the gate's AWS side in moto: the login KMS key, the machine role's
grant on it (constrained to this controller's encryption context, as Core
creates it), and the Secrets Manager secret holding the worker's v2 bundle.
Prints what the rest of the setup needs as JSON."""

import json
import sys

import boto3

ENDPOINT = "http://127.0.0.1:5000"
REGION = "us-east-1"
settings = json.loads(sys.argv[1])

session = boto3.session.Session(
    aws_access_key_id="gate", aws_secret_access_key="gate", region_name=REGION
)
kms = session.client("kms", endpoint_url=ENDPOINT)
secrets = session.client("secretsmanager", endpoint_url=ENDPOINT)

key = kms.create_key(Description="cc-gate provider logins", KeyUsage="ENCRYPT_DECRYPT")[
    "KeyMetadata"
]
grant = kms.create_grant(
    KeyId=key["Arn"],
    GranteePrincipal=f"arn:aws:iam::{key['AWSAccountId']}:role/cc-gate-machine-role",
    Operations=["Decrypt"],
    Constraints={"EncryptionContextSubset": settings["context"]},
    Name="cc-gate-controller",
)
worker_bundle = {
    "version": 2,
    "machineId": settings["machine_id"],
    "assignment": settings["assignment"],
    "machineCapability": settings["machine_capability"],
    "apiEndpoint": settings["api_endpoint"],
}
secret = secrets.create_secret(
    Name="switch/hosted/cc-gate-machine", SecretString=json.dumps(worker_bundle)
)
json.dump(
    {
        "key_arn": key["Arn"],
        "grant_token": grant["GrantToken"],
        "grant_id": grant["GrantId"],
        "secret_arn": secret["ARN"],
    },
    sys.stdout,
)
