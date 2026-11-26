# The cluster contract

What the hosted controller's services really send to the Kubernetes API, for this commit, so that a deployment
repository can check its own admission policies and RBAC against it: every good request admitted by exactly the
policies it deploys, every call granted by its RBAC and nothing broader, every alert line with a monitor.

The files are generated, never edited by hand:

    cd deploy/hosted/controller
    uv run python -m switch_hosted_controller.contract --out ../contract

The controller's tests fail when these files differ from a fresh run (`tests/test_contract.py`), so a change to what
a service sends lands together with its contract. `index.json` lists every file with its sha256.

Every value is a placeholder (`fills.json`): an example registry, digests of one repeated digit, documentation
addresses (RFC 5737), a made-up zone and made-up keyed ids. The generator refuses to write anything that looks real
(a 12-digit run, an internal or tailnet host name, an address outside the documentation ranges, a keyed id that isn't
obviously made up, a private key). The CA in `fills.json` is a throwaway self-signed certificate whose key was never
kept.

- `admission/good/*.json`: one request per file, as the service's own client sent it. Replay it as a server-side dry
  run: make the `setup` objects first as an administrator, in order, then send `request` (`method`, `path`, `body`)
  impersonating `as`. `operation`, `resource`, `namespace`, `name` and `object` state the same request as admission
  sees it. `expect` is `allow`.
- `rbac.json`: per service account, every call its code made. `(box)` stands for any box namespace
  (`box_namespace`), in `namespace`, or in `name` for the namespace itself.
- `log-lines.json`: the alert lines monitors page on: `service`, and the fixed `words` a monitor matches.
- `tiers.json`: the box sizes the operator's configuration must offer.
- `fills.json`: a placeholder for each `__TOKEN__` the deployed manifests use, matching the samples.
