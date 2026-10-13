from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from time import monotonic
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import NAMESPACE_URL, UUID, uuid5

from .config import ConfigError, ControllerConfig
from .model import DesiredState, Machine, ObservedState
from .store import MachineStore

logger = logging.getLogger(__name__)

ENROLLMENT_CODE_RE = re.compile(r"^swce_[A-Za-z0-9_-]{16,128}$")
BUNDLE_VERSION = 5
MAX_CONTROLLERS = 8
CORE_DESIRED_STATES = {"running", "stopped", "retained", "deleted"}
SETUP_FAILED_MESSAGE = (
    "Cloud machine setup failed. Retry; if it still fails, contact your administrator."
)
NEEDS_ATTENTION_MESSAGE = "The cloud machine needs repair. Contact your server administrator."
NEEDS_ATTENTION_CODE = "machine_needs_attention"
COPIED_STATES = {
    ObservedState.STOPPING,
    ObservedState.STOPPED,
    ObservedState.RETAINED,
    ObservedState.DELETING,
    ObservedState.DELETED,
}
PENDING_STATES = {
    DesiredState.RUNNING: "provisioning",
    DesiredState.STOPPED: "stopping",
    DesiredState.RETAINED: "stopping",
    DesiredState.DELETED: "deleting",
}


def bundle_token(machine_id: str, bundle_revision: int) -> str:
    return str(uuid5(NAMESPACE_URL, f"{machine_id}:{bundle_revision}"))


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise GatewayError(code)


class GatewayError(RuntimeError):
    def __init__(self, status: int, detail: str | None = None):
        self.status = status
        self.detail = detail
        super().__init__(f"Cloud gateway request failed with status {status}.")


@dataclass(frozen=True)
class CoreMachine:
    machine_id: str
    state: str
    desired_state: str
    revision: int
    data_volume_id: str | None
    retain_until: datetime | None

    @classmethod
    def parse(cls, raw: Any) -> CoreMachine:
        if not isinstance(raw, dict):
            raise ConfigError("Cloud gateway returned an invalid machine.")
        revision = raw.get("revision")
        if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
            raise ConfigError("Cloud gateway returned an invalid machine revision.")
        if raw.get("desired_state") not in CORE_DESIRED_STATES:
            raise ConfigError("Cloud gateway returned an invalid machine desired state.")
        if not isinstance(raw.get("state"), str):
            raise ConfigError("Cloud gateway returned an invalid machine state.")
        volume_id = raw.get("data_volume_id")
        if volume_id is not None and (
            not isinstance(volume_id, str) or not re.fullmatch(r"vol-[0-9a-f]+", volume_id)
        ):
            raise ConfigError("Cloud gateway returned an invalid data volume id.")
        return cls(
            machine_id=str(UUID(raw["machine_id"])),
            state=raw["state"],
            desired_state=raw["desired_state"],
            revision=revision,
            data_volume_id=volume_id,
            retain_until=_parse_timestamp(raw.get("retain_until")),
        )


@dataclass(frozen=True)
class GatewayConfig:
    origin: str
    token: str = field(repr=False)
    instance_type: str

    @classmethod
    def load(cls, path: Path) -> GatewayConfig:
        raw = json.loads(path.read_text())
        if not isinstance(raw, dict) or set(raw) != {
            "origin",
            "token",
            "instance_type",
        }:
            raise ConfigError("Cloud gateway configuration keys are invalid.")
        if not all(isinstance(value, str) and value for value in raw.values()):
            raise ConfigError("Cloud gateway configuration values must be strings.")
        url = urlsplit(raw["origin"])
        if (
            url.scheme != "https"
            or not url.hostname
            or url.username
            or url.password
            or url.path
            or url.query
            or url.fragment
        ):
            raise ConfigError("Cloud gateway origin must be an HTTPS origin.")
        if len(raw["token"]) < 32:
            raise ConfigError("Cloud gateway credential is too short.")
        return cls(**raw)


class Gateway:
    def __init__(
        self,
        settings: GatewayConfig,
        config: ControllerConfig,
        store: MachineStore,
    ):
        if settings.instance_type not in config.allowed_instance_types:
            raise ConfigError("Cloud gateway instance type is not allowed.")
        self.settings = settings
        self.config = config
        self.store = store
        self.prepare_failures: dict[str, float] = {}

    def request(
        self, path: str, body: dict | None = None, *, prefix: str = "/gateway/hosted-controller"
    ) -> Any:
        request = Request(
            self.settings.origin + prefix + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={
                "Authorization": "Bearer " + self.settings.token,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        try:
            with build_opener(NoRedirect()).open(request, timeout=120) as response:
                return json.load(response)
        except HTTPError as error:
            detail = None
            if error.code == 422:
                try:
                    value = json.loads(error.read(4096)).get("detail")
                    if isinstance(value, str):
                        detail = value[:512]
                except (ValueError, AttributeError):
                    logger.warning("Gateway returned an invalid validation response.")
            raise GatewayError(error.code, detail) from None
        except (URLError, TimeoutError):
            raise GatewayError(503) from None

    def machines(self) -> list[dict]:
        response = self.request("/machines")
        if not isinstance(response, dict) or not isinstance(response.get("machines"), list):
            raise ConfigError("Cloud gateway returned an invalid machine list.")
        return response["machines"]

    def sync_machines(self, listed: list[dict]) -> None:
        active_ids = {item.get("machine_id") for item in listed if isinstance(item, dict)}
        self.prepare_failures = {
            key: started for key, started in self.prepare_failures.items() if key in active_ids
        }
        for item in listed:
            try:
                core = CoreMachine.parse(item)
            except Exception as error:
                logger.error("Ignoring an invalid cloud machine: %s", type(error).__name__)
                continue
            try:
                self.sync_machine(core)
                self.prepare_failures.pop(core.machine_id, None)
            except Exception as error:
                self._record_failure(core, error)

    def _record_failure(self, core: CoreMachine, error: Exception) -> None:
        logger.error(
            "Cloud machine preparation failed for %s: %s", core.machine_id, type(error).__name__
        )
        if core.desired_state != "running":
            return
        if isinstance(error, GatewayError) and error.status == 409:
            return
        terminal = isinstance(error, ConfigError) or (
            isinstance(error, GatewayError) and error.status == 422
        )
        first_failure = self.prepare_failures.setdefault(core.machine_id, monotonic())
        if not terminal and monotonic() - first_failure < 300:
            return
        machine = self._row(core)
        if machine is not None:
            try:
                self.store.set_desired(machine.machine_id, DesiredState.STOPPED, core.retain_until)
            except Exception as stop_error:
                logger.error(
                    "Could not stop failed machine %s: %s",
                    core.machine_id,
                    type(stop_error).__name__,
                )
        message = (
            error.detail
            if isinstance(error, GatewayError) and error.status == 422 and error.detail
            else SETUP_FAILED_MESSAGE
        )
        try:
            self.request(
                f"/machines/{core.machine_id}/observation",
                self.observation(machine, "error", core.revision, message, None),
            )
        except Exception as report_error:
            logger.error(
                "Could not report failed machine %s: %s",
                core.machine_id,
                type(report_error).__name__,
            )

    def _row(self, core: CoreMachine) -> Machine | None:
        return self.store.find(core.machine_id)

    def sync_machine(self, core: CoreMachine) -> None:
        machine = self.store.find(core.machine_id)
        if machine is None:
            if core.state == "error" and core.desired_state in {"running", "stopped"}:
                return
            machine = self.store.insert(
                machine_id=core.machine_id,
                core_revision=core.revision,
                instance_type=self.settings.instance_type,
                image_id=self.config.image_id,
                max_machines=self.config.max_machines,
            )
        machine = self.store.record_core_revision(machine.machine_id, core.revision)
        if machine.core_revision > core.revision:
            logger.warning(
                "Ignoring machine %s at revision %s: revision %s is already recorded.",
                core.machine_id,
                core.revision,
                machine.core_revision,
            )
            return
        if core.data_volume_id is not None:
            if machine.data_volume_id is None:
                machine = self.store.record_volume(
                    machine.machine_id, core.data_volume_id, self.config.availability_zone
                )
            elif machine.data_volume_id != core.data_volume_id:
                raise ConfigError(
                    "Cloud gateway reports a different data volume than the controller recorded."
                )

        if core.desired_state == "deleted":
            if machine.desired_state is DesiredState.DELETED or _at_rest(machine):
                self.store.set_desired(machine.machine_id, DesiredState.DELETED, core.retain_until)
            elif machine.desired_state is not DesiredState.RETAINED:
                self.store.set_desired(machine.machine_id, DesiredState.RETAINED, core.retain_until)
            return
        if machine.desired_state is DesiredState.DELETED:
            logger.warning(
                "Ignoring desired %s for machine %s: it is already being deleted.",
                core.desired_state,
                core.machine_id,
            )
            return
        if core.desired_state in {"stopped", "retained"}:
            self.store.set_desired(
                machine.machine_id, DesiredState(core.desired_state), core.retain_until
            )
            return
        if core.state == "error":
            self.store.set_desired(machine.machine_id, DesiredState.STOPPED, core.retain_until)
            return

        token = bundle_token(core.machine_id, core.revision)
        machine = self.store.require_bundle(machine.machine_id, core.revision, token)
        if machine.required_bundle_token != token:
            logger.warning(
                "Ignoring machine %s at revision %s: revision %s is already required.",
                core.machine_id,
                core.revision,
                machine.required_bundle_revision,
            )
            return
        machine = self.store.set_desired(
            machine.machine_id, DesiredState.RUNNING, core.retain_until
        )
        if machine.data_volume_id is None or machine.bundle_token == token:
            return
        prepared = self.request(f"/machines/{core.machine_id}/prepare", {})
        if not isinstance(prepared, dict) or str(UUID(prepared["machine_id"])) != core.machine_id:
            raise ConfigError("Cloud gateway prepared a different machine.")
        if prepared["revision"] != machine.core_revision:
            logger.warning(
                "Machine %s moved from revision %s to %s during preparation; waiting for the next poll.",
                core.machine_id,
                machine.core_revision,
                prepared["revision"],
            )
            return
        if prepared["bundle_revision"] != machine.core_revision:
            raise ConfigError("Cloud gateway prepared a bundle for a different revision.")
        bundle = self.bundle(prepared, machine)
        self.store.record_bundle(
            machine.machine_id, token, json.dumps(bundle, separators=(",", ":"))
        )

    def report_observations(self, listed: list[dict]) -> None:
        for item in listed:
            try:
                core = CoreMachine.parse(item)
            except Exception as error:
                logger.error("Ignoring an invalid cloud machine: %s", type(error).__name__)
                continue
            if core.state == "error" and core.desired_state in {"running", "stopped"}:
                continue
            machine = self._row(core)
            if machine is None:
                continue
            state = "provisioning"
            if machine.observed_state is ObservedState.RUNNING:
                state = "running"
            elif machine.observed_state is ObservedState.NEEDS_ATTENTION:
                state = "error"
            elif core.desired_state == "deleted" and machine.observed_state in {
                ObservedState.PENDING,
                ObservedState.RETAINED,
            }:
                state = "deleting"
            elif machine.observed_state is ObservedState.PENDING:
                state = PENDING_STATES[machine.desired_state]
            elif machine.observed_state in COPIED_STATES:
                state = machine.observed_state.value
            if state == "error":
                logger.error("Cloud machine %s needs repair: %s", core.machine_id, machine.error)
            try:
                self.request(
                    f"/machines/{core.machine_id}/observation",
                    self.observation(
                        machine,
                        state,
                        machine.core_revision,
                        NEEDS_ATTENTION_MESSAGE if state == "error" else None,
                        NEEDS_ATTENTION_CODE if state == "error" else None,
                    ),
                )
            except Exception as error:
                logger.error(
                    "Could not report machine %s: %s", core.machine_id, type(error).__name__
                )

    def observation(
        self,
        machine: Machine | None,
        state: str,
        revision: int,
        error: str | None,
        error_code: str | None,
    ) -> dict:
        return {
            "state": state,
            "revision": revision,
            "error": error,
            "error_code": error_code,
            "data_volume_id": machine.data_volume_id if machine else None,
            "instance_id": machine.instance_id if machine else None,
            "instance_type": machine.instance_type if machine else None,
        }

    def bundle(self, prepared: dict, machine: Machine) -> dict:
        """The bundle a machine boots its agents controllers from, its
        instance's user data: one controller per workspace seated on the
        machine, each the controller it enrolled as or the one-time code it
        enrolls with until it has one. Never a long-lived credential: the
        machine keeps the ones it enrolls with on its own data volume."""
        endpoint = prepared.get("api_endpoint")
        url = urlsplit(endpoint) if isinstance(endpoint, str) else None
        if url is None or url.scheme != "https" or not url.hostname:
            raise ConfigError("Cloud gateway returned no valid API endpoint.")
        controllers = prepared.get("controllers")
        if not isinstance(controllers, list) or not 1 <= len(controllers) <= MAX_CONTROLLERS:
            raise ConfigError("Cloud gateway returned no valid controllers for the machine.")
        entries = [_controller_entry(controller) for controller in controllers]
        if len({entry["key"] for entry in entries}) != len(entries):
            raise ConfigError("Cloud gateway returned duplicate controller keys.")
        return {
            "version": BUNDLE_VERSION,
            "installationId": self.config.installation_id,
            "machineId": machine.machine_id,
            "dataVolumeId": machine.data_volume_id,
            "apiEndpoint": endpoint,
            "controllers": entries,
        }


def _controller_entry(controller: Any) -> dict:
    if not isinstance(controller, dict):
        raise ConfigError("Cloud gateway returned an invalid controller.")
    key = _uuid(controller.get("key"), "Cloud gateway returned an invalid controller key.")
    controller_id = controller.get("id")
    code = controller.get("enrollment_code")
    if controller_id is not None:
        if code is not None:
            raise ConfigError("Cloud gateway returned an invalid controller.")
        controller_id = _uuid(controller_id, "Cloud gateway returned an invalid controller.")
    elif not isinstance(code, str) or not ENROLLMENT_CODE_RE.fullmatch(code):
        raise ConfigError("Cloud gateway returned no valid enrollment code.")
    return {"key": key, "id": controller_id, "enrollmentCode": code}


def _uuid(value: Any, message: str) -> str:
    if not isinstance(value, str):
        raise ConfigError(message)
    try:
        return str(UUID(value))
    except ValueError:
        raise ConfigError(message) from None


def _at_rest(machine: Machine) -> bool:
    return (
        machine.desired_state in {DesiredState.STOPPED, DesiredState.RETAINED}
        and machine.observed_state.value == machine.desired_state.value
        and machine.observed_revision == machine.desired_revision
        and machine.observed_operation_id == machine.operation_id
    )


def _parse_timestamp(value: Any) -> datetime | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ConfigError("Cloud gateway returned an invalid retain_until.")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        raise ConfigError("Cloud gateway returned an invalid retain_until.") from None
    if parsed.tzinfo is None:
        raise ConfigError("Cloud gateway returned a retain_until without a time zone.")
    return parsed
