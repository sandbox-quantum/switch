"""The mattermostdriver client, without following redirects.

The server URL is the tenant's, so a redirect from it can point anywhere,
including an address the outbound policy would refuse. The driver's own client
calls `requests.get` / `post` / ... with their defaults, which follow
redirects, and offers no option to stop it. This replaces its one request
method with the same request made with `allow_redirects=False`, and raises the
same exception types for the same statuses.
"""

from __future__ import annotations

import logging
from typing import Any

import requests
from mattermostdriver.client import Client
from mattermostdriver.exceptions import (
    ContentTooLarge,
    FeatureDisabled,
    InvalidOrMissingParameters,
    MethodNotAllowed,
    NoAccessTokenProvided,
    NotEnoughPermissions,
    ResourceNotFound,
)

logger = logging.getLogger(__name__)

_ERRORS_BY_STATUS: dict[int, type[requests.HTTPError]] = {
    400: InvalidOrMissingParameters,
    401: NoAccessTokenProvided,
    403: NotEnoughPermissions,
    404: ResourceNotFound,
    405: MethodNotAllowed,
    413: ContentTooLarge,
    501: FeatureDisabled,
}


class MattermostRedirectRefused(requests.HTTPError):
    """The Mattermost server answered with a redirect, which is not followed."""


class NoRedirectClient(Client):  # type: ignore[misc]
    def make_request(
        self,
        method: str,
        endpoint: str,
        options: Any = None,
        params: Any = None,
        data: Any = None,
        files: Any = None,
        basepath: str | None = None,
    ) -> requests.Response:
        if basepath:
            url = "{scheme:s}://{url:s}:{port:d}{basepath:s}".format(
                scheme=self._options["scheme"],
                url=self._options["url"],
                port=self._options["port"],
                basepath=basepath,
            )
        else:
            url = self.url
        request_params: dict[str, Any] = {
            "headers": self.auth_header(),
            "verify": self._verify,
            "json": options if options is not None else {},
            "params": params if params is not None else {},
            "data": data if data is not None else {},
            "files": files,
            "timeout": self.request_timeout,
            "allow_redirects": False,
        }
        if self._auth is not None:
            request_params["auth"] = self._auth()

        response = requests.request(method.upper(), url + endpoint, **request_params)
        if response.is_redirect:
            raise MattermostRedirectRefused(
                f"The Mattermost server redirected {endpoint} to "
                f"{response.headers.get('Location')!r}. Switch does not follow "
                "redirects from a Mattermost server; set the bridge's url to "
                "the address the server answers on.",
                response=response,
            )
        try:
            response.raise_for_status()
        except requests.HTTPError as exc:
            try:
                body = exc.response.json()
                message = body.get("message", body)
            except ValueError:
                message = response.text
            logger.error("Mattermost %s %s failed: %s", method, endpoint, message)
            error = _ERRORS_BY_STATUS.get(exc.response.status_code)
            if error is not None:
                raise error(message) from None
            raise
        return response
