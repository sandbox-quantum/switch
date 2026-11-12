from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest
import requests
from mattermostdriver.exceptions import ResourceNotFound

from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)


def _adapter() -> MattermostAdapter:
    return MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm.example",
            admin_user="admin",
            admin_password="pw",
            team_name="team",
            callback_base_url=None,
        )
    )


@pytest.fixture
async def connected_adapter() -> MattermostAdapter:
    adapter = _adapter()
    driver = MagicMock()
    adapter._admin_driver = driver
    adapter._main_loop = asyncio.get_running_loop()
    return adapter


@pytest.mark.asyncio
async def test_get_external_user_id_returns_id_when_user_exists(
    connected_adapter: MattermostAdapter,
) -> None:
    driver = connected_adapter._admin_driver
    driver.users.get_user_by_username.return_value = {"id": "user-uuid-123", "username": "ada"}

    user_id = await connected_adapter.get_external_user_id("ada")
    assert user_id == "user-uuid-123"
    driver.users.get_user_by_username.assert_called_once_with("ada")


@pytest.mark.asyncio
async def test_get_external_user_id_returns_none_on_resource_not_found(
    connected_adapter: MattermostAdapter,
) -> None:
    driver = connected_adapter._admin_driver
    driver.users.get_user_by_username.side_effect = ResourceNotFound("User not found")

    user_id = await connected_adapter.get_external_user_id("missing_user")
    assert user_id is None


@pytest.mark.asyncio
async def test_get_external_user_id_returns_none_on_404_http_error(
    connected_adapter: MattermostAdapter,
) -> None:
    driver = connected_adapter._admin_driver
    response = requests.Response()
    response.status_code = 404
    driver.users.get_user_by_username.side_effect = requests.exceptions.HTTPError(
        "404 Client Error", response=response
    )

    user_id = await connected_adapter.get_external_user_id("missing_user")
    assert user_id is None


@pytest.mark.asyncio
async def test_get_external_user_id_raises_runtime_error_when_disconnected() -> None:
    adapter = _adapter()
    adapter._admin_driver = None
    adapter._main_loop = None

    with pytest.raises(RuntimeError, match="Mattermost client not connected"):
        await adapter.get_external_user_id("ada")


@pytest.mark.asyncio
async def test_get_external_user_id_reraises_on_500_http_error(
    connected_adapter: MattermostAdapter,
) -> None:
    driver = connected_adapter._admin_driver
    response = requests.Response()
    response.status_code = 500
    driver.users.get_user_by_username.side_effect = requests.exceptions.HTTPError(
        "500 Internal Server Error", response=response
    )

    with pytest.raises(requests.exceptions.HTTPError):
        await connected_adapter.get_external_user_id("ada")


@pytest.mark.asyncio
async def test_get_external_user_id_reraises_on_timeout(
    connected_adapter: MattermostAdapter,
) -> None:
    driver = connected_adapter._admin_driver
    driver.users.get_user_by_username.side_effect = requests.exceptions.Timeout("Connection timed out")

    with pytest.raises(requests.exceptions.Timeout):
        await connected_adapter.get_external_user_id("ada")


@pytest.mark.asyncio
async def test_get_external_user_id_reraises_on_malformed_response(
    connected_adapter: MattermostAdapter,
) -> None:
    driver = connected_adapter._admin_driver
    # Response dictionary missing "id" key
    driver.users.get_user_by_username.return_value = {"username": "ada"}

    with pytest.raises(KeyError):
        await connected_adapter.get_external_user_id("ada")
