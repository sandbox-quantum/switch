import json
import logging
from itertools import count
from urllib.error import HTTPError

import pytest

from switch_hosted_controller.egress_lists import (
    PARTS,
    BoxEgress,
    EgressConfigError,
    EgressKubeApi,
    box_files,
    hash_matches,
    load_egress,
    login_from_url,
    new_password,
    parse_egress,
    passwd_hashes,
    reconcile_once,
    sha512_crypt,
)

BOXES = {
    "11111111-1111-1111-1111-111111111111": "agents-user-ada",
    "22222222-2222-2222-2222-222222222222": "agents-user-bo",
}
PROXY = "squid.egress-proxy.svc:3128"


def write(tmp_path, doc, mode=0o600):
    path = tmp_path / "egress.json"
    path.write_text(json.dumps(doc))
    path.chmod(mode)
    return path


# ---- SHA-512 crypt, against the specification's own vectors ----


def test_sha512_crypt_matches_the_specification():
    assert sha512_crypt("Hello world!", "saltstring") == (
        "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1"
    )
    assert sha512_crypt("Hello world!", "saltstringsaltstring", rounds=10000) == (
        "$6$rounds=10000$saltstringsaltst$OW1/O6BYHV6BcXZu8QVeXbDWra3Oeqh0sbHbbMCVNSnCM/UrjmM0Dp8vOuZeHBy/"
        "YTBmSK6H9qs/y3RnOaw5v."
    )


def test_a_new_password_is_32_random_bytes_and_safe_in_a_url():
    a, b = new_password(), new_password()
    assert a != b and len(a) == 43
    assert all(c.isalnum() or c in "-_" for c in a)


# ---- the operator's egress file ----


def test_boxes_not_in_the_file_get_the_default_and_the_file_overrides(tmp_path):
    path = write(
        tmp_path,
        {
            "agents-user-ada": {
                "parts": ["github", "github-downloads"],
                "extras": ["example.org"],
                "split": True,
            }
        },
    )
    ada, bo = load_egress(path, BOXES, ("github",))
    assert ada == BoxEgress(
        "agents-user-ada", ("github", "github-downloads"), ("example.org",), True
    )
    assert bo == BoxEgress("agents-user-bo", ("github",))


@pytest.mark.parametrize(
    "doc",
    [
        {"agents-user-zed": {}},  # not in the box map
        {"kube-system": {}},
        {"agents-user-ada": {"parts": ["ai-providers"]}},  # follows the split rule, never chosen
        {"agents-user-ada": {"parts": ["base"]}},
        {"agents-user-ada": {"parts": ["everything"]}},
        {"agents-user-ada": {"extras": ["not a host"]}},
        {"agents-user-ada": {"extras": ["10.0.0.1"]}},
        {"agents-user-ada": {"extras": ["evil.com\nhttp_access allow all"]}},
        {"agents-user-ada": {"extras": [f"h{i}.example.org" for i in range(11)]}},
        {"agents-user-ada": {"split": "yes"}},
        {"agents-user-ada": {"parts": ["github"], "owner": "x"}},
        [],
    ],
)
def test_a_bad_egress_file_is_refused_whole(tmp_path, doc):
    with pytest.raises(EgressConfigError):
        load_egress(write(tmp_path, doc), BOXES, ())


def test_an_egress_file_others_can_read_is_refused(tmp_path):
    with pytest.raises(EgressConfigError):
        load_egress(write(tmp_path, {}, mode=0o644), BOXES, ())


def test_a_bad_default_part_is_refused(tmp_path):
    with pytest.raises(EgressConfigError):
        load_egress(write(tmp_path, {}), BOXES, ("ai-providers",))


# ---- what each box's list holds ----


def test_an_unsplit_box_keeps_the_provider_hosts_on_its_own_login_as_today():
    box = BoxEgress("agents-user-bo", ())
    assert set(box.agent_hosts()) == set(PARTS["base"]) | set(PARTS["ai-providers"])
    files = box_files(box)
    assert set(files) == {"bo.conf", "bo.list"}
    assert "github.com" not in files["bo.list"]


def test_a_split_box_moves_the_provider_hosts_to_the_controllers_login_only():
    box = BoxEgress("agents-user-ada", ("github",), split=True)
    assert not set(box.agent_hosts()) & set(PARTS["ai-providers"])
    assert set(PARTS["ai-providers"]) <= set(box.ctl_hosts())
    files = box_files(box)
    assert files["ada.conf"].splitlines()[1:] == [
        "acl b_ada proxy_auth box-ada",
        'acl l_ada dstdomain -n "/etc/squid/boxes/ada.list"',
        "http_access allow CONNECT b_ada l_ada",
        "acl c_ada proxy_auth box-ada-ctl",
        'acl lc_ada dstdomain -n "/etc/squid/boxes/ada.ctl.list"',
        "http_access allow CONNECT c_ada lc_ada",
    ]
    assert "aiplatform.googleapis.com" in files["ada.ctl.list"]


def test_github_downloads_are_off_unless_asked_for_on_their_own():
    assert (
        "raw.githubusercontent.com" not in BoxEgress("agents-user-ada", ("github",)).agent_hosts()
    )
    assert (
        "raw.githubusercontent.com"
        in BoxEgress("agents-user-ada", ("github-downloads",)).agent_hosts()
    )


# ---- the generator ----


class FakeKube:
    def __init__(self, logins):
        self.logins = logins  # namespace -> dict, or absent for a missing Secret
        self.files: dict[str, str] = {"gone.conf": "old", "gone.list": "old"}
        self.passwd_text = ""
        self.writes = []

    def login(self, namespace):
        return dict(self.logins[namespace]) if namespace in self.logins else None

    def set_login(self, namespace, values):
        self.writes.append(("login", namespace))
        self.logins[namespace] = dict(values)

    def boxes_files(self):
        return dict(self.files)

    def patch_boxes_files(self, changes):
        self.writes.append(("files", sorted(changes)))
        for key, value in changes.items():
            if value is None:
                self.files.pop(key, None)
            else:
                self.files[key] = value

    def passwd(self):
        return self.passwd_text

    def set_passwd(self, text):
        self.writes.append(("passwd",))
        self.passwd_text = text


def fixed():
    n = count()
    return (lambda: f"pw{next(n):040d}"), (lambda: "abcdefghijklmnop")


def test_the_generator_makes_logins_writes_the_files_and_removes_a_gone_box():
    kube = FakeKube({"agents-user-ada": {}, "agents-user-bo": {}})
    boxes = [BoxEgress("agents-user-ada", ("github",), split=True), BoxEgress("agents-user-bo", ())]
    pw, salt = fixed()
    result = reconcile_once(kube, boxes, PROXY, pw, salt)
    assert (result.boxes, result.logins_made, result.skipped) == (2, 2, 0)
    ada = kube.logins["agents-user-ada"]
    # Only the keys P7 lets the generator write: the two URLs, each with its login in it.
    assert set(ada) == {"https_proxy", "ctl_https_proxy"}
    assert set(kube.logins["agents-user-bo"]) == {"https_proxy"}
    password = login_from_url(ada["https_proxy"], "box-ada", PROXY)
    ctl_password = login_from_url(ada["ctl_https_proxy"], "box-ada-ctl", PROXY)
    assert password and ctl_password and password != ctl_password
    hashes = passwd_hashes(kube.passwd_text)
    assert hashes["box-ada"] == sha512_crypt(password, "abcdefghijklmnop")
    assert hash_matches(ctl_password, hashes["box-ada-ctl"])
    assert set(kube.files) == {
        "ada.conf",
        "ada.list",
        "ada.ctl.list",
        "bo.conf",
        "bo.list",
    }  # gone.* removed
    lines = kube.passwd_text.splitlines()
    assert [line.split(":")[0] for line in lines] == ["box-ada", "box-ada-ctl", "box-bo"]
    assert all(line.split(":", 1)[1].startswith("$6$") for line in lines)
    assert password not in kube.passwd_text and ctl_password not in kube.passwd_text  # hashes only


def test_a_second_run_changes_nothing_so_squid_isnt_reloaded():
    kube = FakeKube({"agents-user-ada": {}, "agents-user-bo": {}})
    boxes = [BoxEgress("agents-user-ada", ()), BoxEgress("agents-user-bo", ())]
    reconcile_once(kube, boxes, PROXY)
    before = dict(kube.logins["agents-user-ada"])
    kube.writes.clear()
    result = reconcile_once(kube, boxes, PROXY)
    assert kube.writes == [] and result.logins_made == 0 and not result.passwd_changed
    assert (
        kube.logins["agents-user-ada"] == before
    )  # the box keeps its password and its HTTPS_PROXY


def test_unsplitting_a_box_removes_its_controller_login():
    kube = FakeKube({"agents-user-ada": {}})
    reconcile_once(kube, [BoxEgress("agents-user-ada", (), split=True)], PROXY)
    reconcile_once(kube, [BoxEgress("agents-user-ada", ())], PROXY)
    assert not any(k.startswith("ctl_") for k in kube.logins["agents-user-ada"])
    assert "box-ada-ctl" not in kube.passwd_text and "ada.ctl.list" not in kube.files


def test_a_box_without_its_login_secret_is_skipped_and_the_others_carry_on():
    kube = FakeKube({"agents-user-bo": {}})
    result = reconcile_once(
        kube, [BoxEgress("agents-user-ada", ()), BoxEgress("agents-user-bo", ())], PROXY
    )
    assert result.skipped == 1
    assert "ada.conf" not in kube.files and "bo.conf" in kube.files
    assert "box-ada" not in kube.passwd_text


def test_no_password_ever_reaches_a_log_line(caplog):
    kube = FakeKube({"agents-user-ada": {}})
    with caplog.at_level(logging.DEBUG):
        reconcile_once(kube, [BoxEgress("agents-user-ada", ("github",), split=True)], PROXY)

        class Broken(FakeKube):
            def set_login(self, namespace, values):
                raise RuntimeError(f"api down for {namespace}")

        reconcile_once(Broken({"agents-user-ada": {}}), [BoxEgress("agents-user-ada", ())], PROXY)
    login = kube.logins["agents-user-ada"]
    hashes = passwd_hashes(kube.passwd_text)
    for secret in (
        login_from_url(login["https_proxy"], "box-ada", PROXY),
        login_from_url(login["ctl_https_proxy"], "box-ada-ctl", PROXY),
        hashes["box-ada"],
        hashes["box-ada-ctl"],
        login["https_proxy"],
    ):
        assert secret not in caplog.text
        assert secret[:12] not in caplog.text
    assert "agents-user-ada" in caplog.text  # ids and counts are logged


# ---- the Kubernetes calls ----


class FakeCall:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def __call__(self, method, path, body=None):
        self.calls.append((method, path, body))
        response = self.responses.get((method, path), {})
        if isinstance(response, Exception):
            raise response
        return response


def test_the_api_touches_only_the_three_named_objects():
    call = FakeCall(
        {("GET", "/api/v1/namespaces/agents-user-ada/secrets/switch-proxy-login"): {"data": {}}}
    )
    api = EgressKubeApi(call)
    api.login("agents-user-ada")
    api.set_login("agents-user-ada", {"https_proxy": "http://box-ada:pw@h:1"})
    api.boxes_files()
    api.patch_boxes_files({"ada.conf": "x", "gone.conf": None})
    api.passwd()
    api.set_passwd("box-ada:$6$x$y\n")
    paths = {path for _, path, _ in call.calls}
    assert paths == {
        "/api/v1/namespaces/agents-user-ada/secrets/switch-proxy-login",
        "/api/v1/namespaces/egress-proxy/configmaps/squid-boxes",
        "/api/v1/namespaces/egress-proxy/secrets/squid-passwd",
    }
    assert {method for method, _, _ in call.calls} == {"GET", "PATCH"}
    assert (
        "PATCH",
        "/api/v1/namespaces/egress-proxy/configmaps/squid-boxes",
        {"data": {"ada.conf": "x", "gone.conf": None}},
    ) in call.calls


def test_a_missing_login_secret_reads_as_none_and_other_errors_raise():
    path = "/api/v1/namespaces/agents-user-ada/secrets/switch-proxy-login"
    assert (
        EgressKubeApi(FakeCall({("GET", path): HTTPError("u", 404, "x", {}, None)})).login(
            "agents-user-ada"
        )
        is None
    )
    with pytest.raises(HTTPError):
        EgressKubeApi(FakeCall({("GET", path): HTTPError("u", 403, "x", {}, None)})).login(
            "agents-user-ada"
        )
    with pytest.raises(ValueError):
        EgressKubeApi(FakeCall({})).login("kube-system")


def test_a_passing_api_error_keeps_the_box_on_its_current_list():
    kube = FakeKube({"agents-user-ada": {}, "agents-user-bo": {}})
    boxes = [BoxEgress("agents-user-ada", ("github",)), BoxEgress("agents-user-bo", ())]
    reconcile_once(kube, boxes, PROXY)
    files, passwd = dict(kube.files), kube.passwd_text

    class Flaky(FakeKube):
        def login(self, namespace):
            if namespace == "agents-user-ada":
                raise TimeoutError("api slow")
            return super().login(namespace)

    flaky = Flaky(kube.logins)
    flaky.files, flaky.passwd_text = dict(files), passwd
    result = reconcile_once(flaky, boxes, PROXY)
    assert result.skipped == 1
    assert (
        flaky.files == files and flaky.passwd_text == passwd
    )  # ada not cut off, nothing rewritten


def test_the_loop_rereads_the_files_and_a_refused_file_changes_nothing(caplog):
    kube = FakeKube({"agents-user-ada": {}})
    loads = iter(
        [
            [BoxEgress("agents-user-ada", ())],
            EgressConfigError("agents-user-ada: an extra is not a host name"),
        ]
    )

    def load():
        value = next(loads)
        if isinstance(value, Exception):
            raise value
        return value

    passes = iter([False, False, True])
    from switch_hosted_controller.egress_lists import run

    run(kube, load, PROXY, stop=lambda: next(passes), sleep=lambda s: None)
    writes = len(kube.writes)
    assert writes > 0 and "ada.conf" in kube.files
    assert "refused, nothing changed" in caplog.text


# ---- the gate's own login ----


def test_the_gate_gets_its_own_login_with_only_its_listed_hosts(tmp_path):
    from switch_hosted_controller.egress_lists import GATE_NAMESPACE

    boxes = load_egress(write(tmp_path, {"_gate": {"hosts": ["pypi.org"]}}), BOXES, ())
    gate = next(b for b in boxes if b.namespace == GATE_NAMESPACE)
    assert gate.user == "gate-check" and gate.agent_hosts() == ["pypi.org"]
    files = box_files(gate)
    assert set(files) == {"_gate.conf", "_gate.list"}
    assert "acl b__gate proxy_auth gate-check" in files["_gate.conf"]
    assert files["_gate.list"] == "pypi.org\n"  # no base, no providers: only what its check needs
    kube = FakeKube({GATE_NAMESPACE: {}, "agents-user-ada": {}, "agents-user-bo": {}})
    reconcile_once(kube, boxes, PROXY)
    assert kube.logins[GATE_NAMESPACE]["https_proxy"].startswith("http://gate-check:")


@pytest.mark.parametrize(
    "gate",
    [
        {},
        {"hosts": []},
        {"hosts": ["not a host"]},
        {"hosts": ["a.org"], "extra": 1},
        [],
        {"hosts": [f"h{i}.org" for i in range(11)]},
    ],
)
def test_a_bad_gate_entry_is_refused(tmp_path, gate):
    with pytest.raises(EgressConfigError):
        load_egress(write(tmp_path, {"_gate": gate}), BOXES, ())


def test_the_api_may_write_the_gates_login_and_nothing_else_outside_box_namespaces():
    call = FakeCall({})
    EgressKubeApi(call).login("switch-node-gate")
    assert call.calls[0][1] == "/api/v1/namespaces/switch-node-gate/secrets/switch-proxy-login"
    with pytest.raises(ValueError):
        EgressKubeApi(call).login("egress-proxy")


# ---- the box template check ----


def env(name, key, secret="switch-proxy-login"):
    return {"name": name, "valueFrom": {"secretKeyRef": {"name": secret, "key": key}}}


GOOD_SPLIT = {
    "containers": [
        {
            "name": "agents",
            "env": [env("HTTPS_PROXY", "https_proxy"), env("https_proxy", "https_proxy")],
        },
        {"name": "controller", "env": [env("SWITCH_CONTROLLER_GATEWAY_PROXY", "ctl_https_proxy")]},
    ]
}


def test_a_well_formed_box_template_passes():
    from switch_hosted_controller.egress_lists import check_box_pod_spec

    assert check_box_pod_spec(GOOD_SPLIT, split=True) == []
    unsplit = {"containers": [{"name": "box", "env": [env("HTTPS_PROXY", "https_proxy")]}]}
    assert check_box_pod_spec(unsplit, split=False) == []


@pytest.mark.parametrize(
    ("spec", "split", "says"),
    [
        (
            {"containers": [{"name": "agents", "env": [env("X", "ctl_https_proxy")]}]},
            True,
            "controller's login",
        ),
        (
            {
                "containers": [
                    {"name": "agents", "envFrom": [{"secretRef": {"name": "switch-proxy-login"}}]}
                ]
            },
            False,
            "envFrom",
        ),
        (
            {
                "volumes": [{"name": "v", "secret": {"secretName": "switch-proxy-login"}}],
                "containers": [],
            },
            False,
            "mounts",
        ),
        (
            {
                "volumes": [
                    {
                        "name": "v",
                        "projected": {"sources": [{"secret": {"name": "switch-proxy-login"}}]},
                    }
                ],
                "containers": [],
            },
            False,
            "mounts",
        ),
        (
            {"containers": [{"name": "agents", "env": [env("P", "password")]}]},
            False,
            "no container may take",
        ),
        (
            {"containers": [{"name": "controller", "env": [env("P", "ctl_https_proxy")]}]},
            False,
            "isn't split",
        ),
        (
            {
                "initContainers": [{"name": "init", "env": [env("P", "ctl_https_proxy")]}],
                "containers": [],
            },
            True,
            "controller's login",
        ),
    ],
)
def test_the_template_check_refuses_every_way_a_container_could_get_the_wrong_login(
    spec, split, says
):
    from switch_hosted_controller.egress_lists import check_box_pod_spec

    problems = check_box_pod_spec(spec, split)
    assert problems and any(says in p for p in problems), problems


def test_the_template_check_command_reads_a_rendered_statefulset(tmp_path, capsys):
    from switch_hosted_controller.egress_lists import check_template_main

    good = tmp_path / "good.json"
    good.write_text(json.dumps({"kind": "StatefulSet", "spec": {"template": {"spec": GOOD_SPLIT}}}))
    assert check_template_main([str(good), "--split"]) == 0
    assert check_template_main([str(good)]) == 1  # the controller's key on a box that isn't split
    assert "REFUSE" in capsys.readouterr().err


@pytest.mark.parametrize(
    "env",
    [
        {"name": "GITHUB_TOKEN", "value": "ghp_x"},
        {"name": "DB_PASSWORD", "value": "x"},
        {"name": "anthropic_api_key", "value": "sk-x"},
        {"name": "CLIENT_SECRET", "value": "x"},
        {"name": "HTTPS_PROXY", "value": "http://box-ada:pw@squid.egress-proxy.svc:3128"},
        {"name": "https_proxy", "value": "http://u:p@h:1"},
    ],
)
def test_the_template_check_refuses_a_credential_as_a_plain_value(env):
    from switch_hosted_controller.egress_lists import check_box_pod_spec

    problems = check_box_pod_spec({"containers": [{"name": "agents", "env": [env]}]}, split=False)
    assert problems and "plain value" in problems[0]


def test_a_proxy_without_a_login_and_references_are_fine():
    from switch_hosted_controller.egress_lists import check_box_pod_spec

    spec = {
        "containers": [
            {
                "name": "agents",
                "env": [
                    {"name": "HTTPS_PROXY", "value": "http://squid.egress-proxy.svc:3128"},
                    {"name": "NO_PROXY", "value": "10.0.0.1,.svc,.cluster.local,localhost"},
                    {
                        "name": "GITHUB_TOKEN",
                        "valueFrom": {"secretKeyRef": {"name": "other", "key": "t"}},
                    },
                    {"name": "EMPTY_KEY", "value": ""},
                ],
            }
        ]
    }
    assert check_box_pod_spec(spec, split=False) == []


# ---- step 2, in the cluster: P7's two keys, the API reads, split by default (A1's blocker) ----


def test_a_login_is_kept_while_its_url_and_squids_hash_agree():
    kube = FakeKube({"agents-user-ada": {}})
    box = [BoxEgress("agents-user-ada", (), split=True)]
    reconcile_once(kube, box, PROXY)
    before = dict(kube.logins["agents-user-ada"])
    kube.writes.clear()
    reconcile_once(kube, box, PROXY)
    assert kube.writes == [] and kube.logins["agents-user-ada"] == before


@pytest.mark.parametrize(
    "damage", ["no_line", "other_hash", "not_6", "other_user_url", "other_proxy"]
)
def test_a_login_that_doesnt_check_out_is_replaced_not_reused(damage):
    """A stale or missing `squid-passwd` line, or a URL that isn't ours, gets a new login."""
    kube = FakeKube({"agents-user-ada": {}})
    box = [BoxEgress("agents-user-ada", ())]
    reconcile_once(kube, box, PROXY)
    url = kube.logins["agents-user-ada"]["https_proxy"]
    if damage == "no_line":
        kube.passwd_text = ""
    elif damage == "other_hash":
        kube.passwd_text = f"box-ada:{sha512_crypt('something-else', 'abcdefghijklmnop')}\n"
    elif damage == "not_6":
        kube.passwd_text = "box-ada:$1$abc$def\n"
    elif damage == "other_user_url":
        kube.logins["agents-user-ada"]["https_proxy"] = url.replace("box-ada:", "box-bo:")
    else:
        kube.logins["agents-user-ada"]["https_proxy"] = url.replace(PROXY, "evil.example:3128")
    result = reconcile_once(kube, box, PROXY)
    new_url = kube.logins["agents-user-ada"]["https_proxy"]
    assert result.logins_made == 1 and new_url != url
    password = login_from_url(new_url, "box-ada", PROXY)
    assert hash_matches(password, passwd_hashes(kube.passwd_text)["box-ada"])


def test_an_older_eight_key_secret_keeps_its_url_and_loses_the_rest():
    """A Secret an older generator filled: the URL stays (so the box's HTTPS_PROXY doesn't change), and the
    username, password and hash keys P7 doesn't allow are removed."""
    password = "a" * 43
    url = f"http://box-ada:{password}@{PROXY}"
    line_hash = sha512_crypt(password, "abcdefghijklmnop")
    kube = FakeKube(
        {
            "agents-user-ada": {
                "username": "box-ada",
                "password": password,
                "hash": line_hash,
                "https_proxy": url,
            }
        }
    )
    kube.passwd_text = f"box-ada:{line_hash}\n"
    reconcile_once(kube, [BoxEgress("agents-user-ada", ())], PROXY)
    assert kube.logins["agents-user-ada"] == {"https_proxy": url}
    assert passwd_hashes(kube.passwd_text) == {"box-ada": line_hash}


def test_hash_matches_reads_the_hashs_own_salt_at_the_default_cost_only():
    assert hash_matches("Hello world!", sha512_crypt("Hello world!", "saltstring"))
    assert hash_matches("Hello world!", sha512_crypt("Hello world!", "saltstring", rounds=5000))
    # Any other cost is not trusted (a tampered line could stall every pass), so it never matches.
    assert not hash_matches(
        "Hello world!", sha512_crypt("Hello world!", "saltstring", rounds=10000)
    )
    assert not hash_matches("Hello world!", "$6$rounds=999999999$saltstring$x")
    assert not hash_matches("Hello world", sha512_crypt("Hello world!", "saltstring"))
    for bad in ("", "x", "$1$a$b", "$6$rounds=x$a$b", "$6$a"):
        assert not hash_matches("Hello world!", bad)


def test_login_from_url_takes_only_our_exact_form():
    assert login_from_url(f"http://box-ada:pw-1_x@{PROXY}", "box-ada", PROXY) == "pw-1_x"
    for bad in (
        None,
        3,
        f"http://box-ada:@{PROXY}",
        f"http://box-ada:p w@{PROXY}",
        f"http://box-ada:pw@{PROXY}/x",
        f"https://box-ada:pw@{PROXY}",
        f"http://box-adam:pw@{PROXY}",
    ):
        assert login_from_url(bad, "box-ada", PROXY) is None


def test_a_box_with_no_entry_is_split_by_default_and_an_entry_can_say_otherwise():
    ada, bo = parse_egress(
        json.dumps({"agents-user-bo": {"split": False}}), BOXES, (), default_split=True
    )
    assert ada.split and not bo.split
    kube = FakeKube({"agents-user-ada": {}, "agents-user-bo": {}})
    reconcile_once(kube, [ada, bo], PROXY)
    # Template v2.3's controller reads ctl_https_proxy: a provisioned box gets it with no entry of its own.
    assert set(kube.logins["agents-user-ada"]) == {"https_proxy", "ctl_https_proxy"}
    assert set(kube.logins["agents-user-bo"]) == {"https_proxy"}
    # The default can be turned off.
    ada, bo = parse_egress("{}", BOXES, (), default_split=False)
    assert not ada.split and not bo.split


def test_empty_settings_give_every_box_the_defaults():
    ada, bo = parse_egress("{}", BOXES, ("github",), default_split=True)
    assert ada == BoxEgress("agents-user-ada", ("github",), split=True)
    assert bo == BoxEgress("agents-user-bo", ("github",), split=True)


def test_settings_that_arent_json_are_refused():
    with pytest.raises(EgressConfigError):
        parse_egress("{not json", BOXES, ())


def _b64(text):
    import base64

    return base64.b64encode(text.encode()).decode()


BOX_MAP_PATH = "/api/v1/namespaces/switch-hosted/secrets/box-map"
SETTINGS_PATH = "/api/v1/namespaces/egress-lists/secrets/egress-settings"


def test_the_box_map_is_read_by_name_through_the_api():
    call = FakeCall(
        {
            ("GET", BOX_MAP_PATH): {
                "data": {
                    "11111111-1111-1111-1111-111111111111": _b64("agents-user-ada"),
                    "22222222-2222-2222-2222-222222222222": _b64("agents-user-bo\n"),
                }
            }
        }
    )
    assert EgressKubeApi(call).box_map() == BOXES
    assert call.calls == [("GET", BOX_MAP_PATH, None)]


@pytest.mark.parametrize(
    "data",
    [
        {"not-a-machine": _b64("agents-user-ada")},
        {"11111111-1111-1111-1111-111111111111": _b64("kube-system")},
        {
            "11111111-1111-1111-1111-111111111111": _b64("agents-user-ada"),
            "22222222-2222-2222-2222-222222222222": _b64("agents-user-ada"),
        },
        {"11111111-1111-1111-1111-111111111111": "not base64!"},
    ],
)
def test_a_bad_box_map_is_refused_whole(data):
    with pytest.raises(EgressConfigError):
        EgressKubeApi(FakeCall({("GET", BOX_MAP_PATH): {"data": data}})).box_map()


def test_the_settings_are_read_by_name_and_must_hold_one_key():
    call = FakeCall({("GET", SETTINGS_PATH): {"data": {"egress.json": _b64("{}")}}})
    assert EgressKubeApi(call).settings() == "{}"
    assert call.calls == [("GET", SETTINGS_PATH, None)]
    for data in ({}, {"egress.json": _b64("{}"), "other": _b64("x")}, {"other": _b64("{}")}):
        with pytest.raises(EgressConfigError):
            EgressKubeApi(FakeCall({("GET", SETTINGS_PATH): {"data": data}})).settings()


@pytest.mark.parametrize("code", [403, 404])
def test_an_unreadable_box_map_or_settings_writes_nothing(caplog, code):
    """A 403 or 404 on either read logs, and nothing is written that pass."""
    from switch_hosted_controller.egress_lists import run

    for path in (BOX_MAP_PATH, SETTINGS_PATH):
        responses = {
            ("GET", BOX_MAP_PATH): {
                "data": {"11111111-1111-1111-1111-111111111111": _b64("agents-user-ada")}
            },
            ("GET", SETTINGS_PATH): {"data": {"egress.json": _b64("{}")}},
        }
        responses[("GET", path)] = HTTPError("u", code, "x", {}, None)
        call = FakeCall(responses)
        api = EgressKubeApi(call)
        passes = iter([False, True])
        with caplog.at_level(logging.ERROR):
            run(
                api,
                lambda: parse_egress(api.settings(), api.box_map(), (), True),
                PROXY,
                stop=lambda: next(passes),
                sleep=lambda s: None,
            )
        assert {method for method, _, _ in call.calls} == {"GET"}  # no PATCH at all
        assert "refused, nothing changed" in caplog.text
        caplog.clear()


def test_main_uses_the_fresh_token_client_and_reads_through_the_api(tmp_path, monkeypatch):
    from switch_hosted_controller import egress_lists, workers_main

    (tmp_path / "token").write_text("t1")
    (tmp_path / "ca.crt").write_text("x")
    monkeypatch.setattr(workers_main.ssl, "create_default_context", lambda cafile=None: object())
    seen = {}

    def fake_run(kube, load, proxy, stop):
        seen["kube"], seen["proxy"] = kube, proxy

    monkeypatch.setattr(egress_lists, "run", fake_run)
    monkeypatch.setattr(egress_lists.signal, "signal", lambda *a: None)
    env = {"KUBERNETES_SERVICE_HOST": "10.100.0.1"}
    assert egress_lists.main(env, sa_dir=tmp_path) == 0
    assert isinstance(seen["kube"]._call.__self__, workers_main.InClusterKubeApi)
    assert seen["proxy"] == "squid.egress-proxy.svc:3128"


def test_the_fresh_token_client_rereads_a_rotated_token(tmp_path, monkeypatch):
    from switch_hosted_controller import box_scaler, workers_main

    token = tmp_path / "token"
    token.write_text("first")
    monkeypatch.setattr(workers_main.ssl, "create_default_context", lambda cafile=None: object())
    sent = []
    monkeypatch.setattr(
        box_scaler.KubeApi, "_call", lambda self, *a, **k: sent.append(self._token) or {}
    )
    api = workers_main.InClusterKubeApi("https://10.100.0.1:443", token, "ca")
    EgressKubeApi(api._call).box_map()
    token.write_text("second")
    EgressKubeApi(api._call).box_map()
    assert sent == ["first", "second"]


@pytest.mark.parametrize(
    "env",
    [
        {"KUBERNETES_SERVICE_HOST": "10.100.0.1", "SWITCH_EGRESS_DEFAULT_SPLIT": "yes"},
        {"SWITCH_EGRESS_DEFAULT_SPLIT": "true"},  # not in a cluster
        {"KUBERNETES_SERVICE_HOST": "10.100.0.1", "SWITCH_EGRESS_PROXY": "not a proxy"},
    ],
)
def test_main_refuses_to_start_on_a_bad_setting(tmp_path, env):
    from switch_hosted_controller import egress_lists

    assert egress_lists.main(env, sa_dir=tmp_path) == 2


def test_an_entry_without_split_takes_the_default():
    ada, _ = parse_egress(
        json.dumps({"agents-user-ada": {"parts": []}}), BOXES, (), default_split=True
    )
    assert ada.split
    ada, _ = parse_egress(
        json.dumps({"agents-user-ada": {"parts": []}}), BOXES, (), default_split=False
    )
    assert not ada.split


def test_split_is_on_unless_the_setting_turns_it_off():
    from switch_hosted_controller.egress_lists import default_split_from_env

    assert default_split_from_env({}) is True
    assert default_split_from_env({"SWITCH_EGRESS_DEFAULT_SPLIT": "true"}) is True
    assert default_split_from_env({"SWITCH_EGRESS_DEFAULT_SPLIT": "false"}) is False


def test_a_box_map_value_with_stray_characters_is_refused():
    """Strict base64: a value with a character outside the alphabet is refused, not quietly cleaned up."""
    value = _b64("agents-user-ada")
    data = {"11111111-1111-1111-1111-111111111111": value[:4] + "!" + value[4:]}
    with pytest.raises(EgressConfigError):
        EgressKubeApi(FakeCall({("GET", BOX_MAP_PATH): {"data": data}})).box_map()


def test_set_login_sends_each_old_key_as_null_beside_the_two_urls():
    """The real PATCH body clears an older generator's keys, so after the patch the Secret holds only what P7
    allows. Without the nulls a merge patch would leave them, and P7 would refuse it."""
    path = "/api/v1/namespaces/agents-user-ada/secrets/switch-proxy-login"
    old = {k: _b64("old") for k in ("username", "password", "hash", "ctl_username", "https_proxy")}
    call = FakeCall({("GET", path): {"data": old}})
    values = {
        "https_proxy": f"http://box-ada:a@{PROXY}",
        "ctl_https_proxy": f"http://box-ada-ctl:b@{PROXY}",
    }
    EgressKubeApi(call).set_login("agents-user-ada", values)
    method, patched, body = call.calls[-1]
    assert (method, patched) == ("PATCH", path)
    assert body == {
        "data": {
            "https_proxy": _b64(values["https_proxy"]),
            "ctl_https_proxy": _b64(values["ctl_https_proxy"]),
            "username": None,
            "password": None,
            "hash": None,
            "ctl_username": None,
        }
    }
