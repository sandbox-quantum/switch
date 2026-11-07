# Private inconclusive OAuth setup candidate

The inconclusive-save and exact localhost-callback fixes were installed as
targeted updates on the existing local QA checkout. Real Salesforce OAuth,
read-side room calls and later grant-off unavailability were observed.
Natural-expiry renewal is verified by a fresh completed read and later expiry
without another sign-in. Timed grant-off video and Disconnect remain pending.
This final review tree is not a separate live installation.

Each static entry may opt in with `auth.oauth.inconclusive_probe`, a strict list
of measured HTTP400 error/body-status patterns. Definite invalid-client and
redirect errors cannot be listed. Entries must also state `unchecked` operator
requirements. The normal Check and save stores an inconclusive candidate as
unverified, not accepted credentials. The screen explains first sign-in will
validate it. Real PKCE, scopes and authenticated identity checks are unchanged.

After a completed sign-in, only the unchanged saved client is marked verified.
A conditional client ID/timestamp update protects replacement races; config
sources are not mutated. Server/organization caches are refreshed and changes
announced after commit. Failed sign-in never clears the warning.

Salesforce opts in for measured HTTP400 unknown_error. HubSpot needs its own
entry commit using HTTP400 invalid_request with body status BAD_AUTH_CODE.
This branch has no HubSpot entry; it does not silently enable a new connector.
Azure's separate scope/client-check work is not included.

Repository design feedback:
https://github.com/sandbox-quantum/switch/issues/834#issuecomment-6678453504
https://github.com/sandbox-quantum/switch/issues/830#issuecomment-6678453089

Automated fake-vendor tests do not establish actual vendor login, account,
quota, room grants, refresh or demo success.

Regression coverage includes unchanged and replacement-race saved clients for
both server and organization selection, including the right cache notification.
The organization fixture selects a synthetic adapter; this is not vendor proof.

The verification regression also injects bad authorization code, missing scopes
and absent identity. Each refusal leaves the saved client unverified with no
connection and no cache announcement, for server and organization selection.
