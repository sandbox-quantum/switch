#!/usr/bin/env python3
"""Fill the placeholders in the hosted agents v2 cluster files, into a new folder.

    ./fill-placeholders.py --out <new folder> \\
        --server-ip <ip> --api-server-ip <ip> --api-server-ip <ip> \\
        --agents-subnet <cidr> [--agents-subnet <cidr> ...] --zone <zone> [--zone <zone> ...] \\
        --box-image <repo@sha256:...> [--previous-box-image <repo@sha256:...> ...] \\
        --controller-image <repo@sha256:...> --pause-image <repo@sha256:...> \\
        --kubernetes-service-ip <ip> --ca-cert <file.pem>

Reads `k8s/*.yaml`, `box/priorityclass-switch-box.yaml` and
`egress/egress-proxy-networkpolicy.yaml` from beside this script, and writes filled copies, with the same names,
into `--out`, which must not exist yet and must be outside this repo checkout, so a filled copy is never committed.
The repo's own files are never changed. Every value is checked first, and
the run refuses, writing nothing, if any value is malformed or any `__PLACEHOLDER__` would be left.

What each value is (see `k8s/README.md`):
  --server-ip           the Switch server's private address that boxes reach over HTTPS
  --api-server-ip       the cluster API server's private endpoint addresses, exactly two
  --agents-subnet       the gVisor (agents) node subnets, one per zone: the only sources squid accepts. Each
                        must be a private range no wider than /16
  --zone                the zones boxes may run in, one or more
  --box-image           the box image to make new boxes from, by digest
  --previous-box-image  older box images still allowed while boxes move, oldest first, up to two (admission
                        policy P8 admits the current image and two older ones)
  --controller-image    the hosted controller image, by digest (the egress-lists generator uses the same build)
  --pause-image         the placeholder pod's image, by digest
  --kubernetes-service-ip  the cluster's `kubernetes` Service address (`kubectl get svc kubernetes -n default`),
                        which the cluster services' NetworkPolicies allow (the files carry the test cluster's)
  --ca-cert             a PEM file: the CA that signs the Switch server's certificate (its public CA if it's
                        publicly trusted). The box provisioner refuses to start without one.

Standard library only, so it runs wherever Python 3.10+ does.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import re
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
# (name in the filled folder, source). The two extra files are numbered after k8s/'s, so
# `kubectl apply -f <folder>/` applies everything in order.
SOURCES = [(p.name, p) for p in sorted((HERE / "k8s").glob("*.yaml"))] + [
    (
        "70-priorityclass-switch-box.yaml",
        HERE / "box" / "priorityclass-switch-box.yaml",
    ),
    (
        "71-egress-proxy-networkpolicy.yaml",
        HERE / "egress" / "egress-proxy-networkpolicy.yaml",
    ),
]
PLACEHOLDER = re.compile(r"__[A-Z0-9_]+__")
IMAGE = re.compile(r"^[a-z0-9][a-z0-9._\-/:]*@sha256:[0-9a-f]{64}$")
ZONE = re.compile(r"^[a-z]{2}(-[a-z]+)+-[0-9][a-z]$")
MAX_PREVIOUS = 2

# Text the filler rewrites whole, rather than one placeholder at a time, because the number of entries varies.
CONFIG_ALLOWED = """      "allowed_images": [
        "__PREVIOUS_BOX_IMAGE_3__",
        "__PREVIOUS_BOX_IMAGE_2__",
        "__PREVIOUS_BOX_IMAGE_1__"
      ]"""
POLICY_ALLOWED = """in ['__BOX_IMAGE__', '__PREVIOUS_BOX_IMAGE_1__',
      '__PREVIOUS_BOX_IMAGE_2__']"""
CONFIG_ZONES = '"__ZONE__"'
POLICY_ZONES = "in ['__ZONE__']"
# P4 pins pods to a zone pattern; the files carry the test cluster's region.
POLICY_ZONE_PATTERN = "'^eu-west-3[abc]$'"
CA_LINE = "  box-ca.crt: __BOX_CA_CERT__\n"
# The cluster services' NetworkPolicies allow the test cluster's `kubernetes` Service address.
KUBERNETES_SERVICE = "cidr: 172.20.0.1/32"
KUBERNETES_SERVICE_COUNT = {"40-switch-hosted.yaml": 4, "51-egress-lists.yaml": 1}
REPO = HERE.parents[1]


class Refused(Exception):
    pass


def _ip(value: str, what: str) -> str:
    try:
        return str(ipaddress.IPv4Address(value))
    except ValueError as exc:
        raise Refused(f"{what} {value!r} isn't an IPv4 address") from exc


def _image(value: str, what: str) -> str:
    if not IMAGE.fullmatch(value):
        raise Refused(
            f"{what} {value!r} isn't an image pinned by digest (<repo>@sha256:<64 hex>)"
        )
    return value


def checked(args: argparse.Namespace) -> dict[str, object]:
    """Every value, checked, or Refused."""
    if len(args.api_server_ip) != 2:
        raise Refused(
            "give --api-server-ip exactly twice: the API server's two private endpoint addresses"
        )
    subnets = []
    for given in dict.fromkeys(args.agents_subnet):
        try:
            network = ipaddress.IPv4Network(given, strict=True)
        except ValueError as exc:
            raise Refused(
                f"--agents-subnet {given!r} isn't an IPv4 network (e.g. 10.0.32.0/20)"
            ) from exc
        # These become squid's `acl agents src`, who may use the egress proxy.
        if not network.is_private or network.prefixlen < 16:
            raise Refused(
                f"--agents-subnet {given!r} must be a private range no wider than /16: "
                "it decides who may use the egress proxy"
            )
        subnets.append(str(network))
    zones = list(dict.fromkeys(args.zone))
    for zone in zones:
        if not ZONE.fullmatch(zone):
            raise Refused(f"--zone {zone!r} doesn't look like a zone (e.g. eu-west-1a)")
    box = _image(args.box_image, "--box-image")
    previous = [_image(p, "--previous-box-image") for p in args.previous_box_image]
    if len(previous) > MAX_PREVIOUS:
        raise Refused(f"at most {MAX_PREVIOUS} --previous-box-image")
    if len(set(previous)) != len(previous) or box in previous:
        raise Refused(
            "the box images must all differ: the provisioner refuses a repeated image"
        )
    ca = Path(args.ca_cert).read_text(encoding="ascii")
    if (
        not ca.lstrip().startswith("-----BEGIN CERTIFICATE-----")
        or "-----END CERTIFICATE-----" not in ca
    ):
        raise Refused(f"--ca-cert {args.ca_cert} isn't a PEM certificate")
    if "PRIVATE KEY" in ca:
        raise Refused(
            f"--ca-cert {args.ca_cert} holds a private key; give only the CA's certificate"
        )
    return {
        "server_ip": _ip(args.server_ip, "--server-ip"),
        "api": [_ip(a, "--api-server-ip") for a in args.api_server_ip],
        "subnet": " ".join(subnets),
        "zones": zones,
        "box": box,
        "previous": previous,
        "controller": _image(args.controller_image, "--controller-image"),
        "pause": _image(args.pause_image, "--pause-image"),
        "kubernetes": _ip(args.kubernetes_service_ip, "--kubernetes-service-ip"),
        "ca": ca.strip(),
    }


def _replace_once(text: str, old: str, new: str, name: str) -> str:
    if text.count(old) != 1:
        raise Refused(
            f"{name}: expected exactly one {old.splitlines()[0]!r}; the file has changed, update this script"
        )
    return text.replace(old, new)


def fill(name: str, text: str, v: dict[str, object]) -> str:
    previous: list[str] = v["previous"]  # type: ignore[assignment]
    zones: list[str] = v["zones"]  # type: ignore[assignment]
    if name == "40-switch-hosted.yaml":
        oldest_first = json.dumps(previous)
        text = _replace_once(
            text, CONFIG_ALLOWED, f'      "allowed_images": {oldest_first}', name
        )
        text = _replace_once(
            text, CONFIG_ZONES, ", ".join(json.dumps(z) for z in zones), name
        )
        pem = "\n".join("    " + line for line in v["ca"].splitlines())  # type: ignore[union-attr]
        text = _replace_once(text, CA_LINE, f"  box-ca.crt: |\n{pem}\n", name)
    if name == "30-admission-policies.yaml":
        # P8 admits the current box image and up to two earlier ones.
        allowed = [v["box"], *previous]
        text = _replace_once(
            text,
            POLICY_ALLOWED,
            "in [" + ", ".join(f"'{i}'" for i in allowed) + "]",
            name,
        )
        text = _replace_once(
            text, POLICY_ZONES, "in [" + ", ".join(f"'{z}'" for z in zones) + "]", name
        )
        pattern = (
            "^(" + "|".join(zones) + ")$"
        )  # zones are checked: letters, digits and hyphens only
        text = _replace_once(text, POLICY_ZONE_PATTERN, f"'{pattern}'", name)
    count = KUBERNETES_SERVICE_COUNT.get(name, 0)
    if text.count(KUBERNETES_SERVICE) != count:
        raise Refused(
            f"{name}: expected {count} of {KUBERNETES_SERVICE!r}; the file has changed, update this script"
        )
    text = text.replace(KUBERNETES_SERVICE, f"cidr: {v['kubernetes']}/32")
    simple = {
        "__SERVER_IP__": v["server_ip"],
        "__API_SERVER_IP_1__": v["api"][0],  # type: ignore[index]
        "__API_SERVER_IP_2__": v["api"][1],  # type: ignore[index]
        "__AGENTS_SUBNET__": v["subnet"],
        "__BOX_IMAGE__": v["box"],
        "__CONTROLLER_IMAGE__": v["controller"],
        "__EGRESS_LISTS_IMAGE__": v["controller"],
        "__PAUSE_IMAGE__": v["pause"],
    }
    for placeholder, value in simple.items():
        text = text.replace(placeholder, str(value))
    left = sorted(set(PLACEHOLDER.findall(text)))
    if left:
        raise Refused(f"{name}: {', '.join(left)} would be left unfilled")
    return text


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--out", required=True)
    parser.add_argument("--server-ip", required=True)
    parser.add_argument("--api-server-ip", action="append", default=[], required=True)
    parser.add_argument("--agents-subnet", action="append", default=[], required=True)
    parser.add_argument("--zone", action="append", default=[], required=True)
    parser.add_argument("--box-image", required=True)
    parser.add_argument("--previous-box-image", action="append", default=[])
    parser.add_argument("--controller-image", required=True)
    parser.add_argument("--pause-image", required=True)
    parser.add_argument("--kubernetes-service-ip", required=True)
    parser.add_argument("--ca-cert", required=True)
    args = parser.parse_args(argv)
    out = Path(args.out)
    try:
        if out.exists():
            raise Refused(f"--out {out} already exists; give a new folder")
        if out.resolve().is_relative_to(REPO):
            raise Refused(
                f"--out {out} is inside this repo checkout; write the filled copy outside it"
            )
        values = checked(args)
        filled = {
            name: fill(src.name, src.read_text(encoding="utf-8"), values)
            for name, src in SOURCES
        }
    except (Refused, OSError) as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 1
    # Written beside the target and renamed into place, so a failed write leaves nothing half done.
    out.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".fill-", dir=out.parent))
    for name, text in filled.items():
        (staging / name).write_text(text, encoding="utf-8")
    staging.rename(out)
    for name in filled:
        print(out / name)
    print(
        f"filled {len(filled)} files; apply them in name order, e.g. kubectl apply -f {out}/ (see DEPLOY.md)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
