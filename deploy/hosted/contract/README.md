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
- `admission/bad/*.json`: a good request changed so that one policy rule refuses it, one per rule. `expect` is
  `refuse`; `policies` names the policy (or, where two guard the same thing, both) and `message` that rule's message.
  `refused_by: rbac` marks a change the account's RBAC refuses before admission is reached (a verb or object it has
  no grant for). `groups`, when present, are the impersonated user's groups (an administrator, for the rules every
  account meets, or the migration runner's operators' group, as in its good samples). `from_good` names the good sample it was made from.
- `rbac.json`: per service account, every call its code made. `(box)` stands for any box namespace
  (`box_namespace`), in `namespace`, or in `name` for the namespace itself; `names` lists the other names a service
  chooses at run time, each standing for every name of its shape. `groups` names the callers that are people, not
  service accounts (the migration copy runner's operators, each under their own sign-in), with the groups their
  calls are granted through: check those groups' bindings. `builtin` lists Kubernetes' own controllers (the job
  controller making the copy pod), whose grants are the cluster's built-in roles.
- `log-lines.json`: every alert line the services log, each paging: `service` (the pod's Datadog service tag) and
  the fixed `words` its monitor matches (`only_with_any_of`: the monitor matches only lines that also carry one of
  these words).
- `tiers.json`: the box sizes the operator's configuration must offer.
- `fills.json`: a placeholder for each `__TOKEN__` the deployed manifests use, matching the samples.
