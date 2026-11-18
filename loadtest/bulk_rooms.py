# Runs inside a switch-core pod, fed to `python -` over `kubectl exec -i`, for
# the admin-bulk scenario. Unlike pod_sampler.py it writes, and only to what
# the run made: its own rooms (named with its prefix) and one bridge row of
# its own, which stays inactive, so no pod ever starts it and no messaging app
# is called.
#
#   python - shape TENANT PREFIX RUN_ID  give the run's bulk rooms the shape
#                                        an admin's bulk change finds: Public,
#                                        bound to a private channel of a bridge
#   python - reset TENANT PREFIX RUN_ID  make them Public and unarchived again,
#                                        for the next window
#   python - clear TENANT PREFIX RUN_ID  unbind them and delete the bridge, so
#                                        they archive as internal rooms
#
# PREFIX "load-" with RUN_ID "*" clears every load run's. Prints one JSON line.
# Connects with the pod's own DB_* environment, bound to TENANT as the
# server's sessions are, so row-level security applies.
import asyncio
import json
import os
import sys
import uuid

import asyncpg

CHANNEL_TYPE = "channel_private"


def bridge_name(run_id):
    return f"load {run_id} (not connected)"


async def connect(tenant):
    conn = await asyncpg.connect(
        host=os.environ["DB_HOST"],
        port=int(os.environ.get("DB_PORT") or 5432),
        user=os.environ["DB_USER"],
        password=os.environ["DB_PASSWORD"],
        database=os.environ["DB_NAME"],
        ssl="prefer",
    )
    await conn.execute("select set_config('app.tenant_id', $1, false)", tenant)
    return conn


async def shape(conn, tenant, prefix, run_id):
    async with conn.transaction():
        bridge = await conn.fetchval(
            "select id from collaboration_bridges where tenant_id = $1 and display_name = $2",
            tenant,
            bridge_name(run_id),
        )
        if bridge is None:
            client, bridge = str(uuid.uuid4()), str(uuid.uuid4())
            await conn.execute(
                "insert into clients (id, tenant_id, matrix_user_id, display_name, type) "
                "values ($1, $2, $3, $4, 'bridge')",
                client,
                tenant,
                f"@{prefix}bridge:load.invalid",
                bridge_name(run_id),
            )
            await conn.execute(
                "insert into collaboration_bridges "
                "(id, tenant_id, type, display_name, client_id, status) "
                "values ($1, $2, 'mattermost', $3, $4, 'inactive')",
                bridge,
                tenant,
                bridge_name(run_id),
                client,
            )
        status = await conn.execute(
            "update rooms set bridge_id = $1, external_channel_id = 'load-' || id, "
            "channel_type = $2, read_visibility = 'public' "
            "where tenant_id = $3 and starts_with(name, $4) and archived_at is null",
            bridge,
            CHANNEL_TYPE,
            tenant,
            prefix,
        )
    return {"bridge_id": bridge, "rooms": int(status.split()[-1])}


async def reset(conn, tenant, prefix, run_id):
    # Unarchived too: a window stopped between its archive and unarchive
    # clicks leaves them archived.
    status = await conn.execute(
        "update rooms set read_visibility = 'public', archived_at = null "
        "where tenant_id = $1 and starts_with(name, $2) and bridge_id is not null",
        tenant,
        prefix,
    )
    return {"rooms": int(status.split()[-1])}


async def clear(conn, tenant, prefix, run_id):
    name = "load % (not connected)" if run_id == "*" else bridge_name(run_id)
    async with conn.transaction():
        bridges = await conn.fetch(
            "select id, client_id from collaboration_bridges "
            "where tenant_id = $1 and display_name like $2 and status = 'inactive'",
            tenant,
            name,
        )
        ids = [b["id"] for b in bridges]
        status = await conn.execute(
            "update rooms set bridge_id = null, external_channel_id = null, channel_type = null "
            "where tenant_id = $1 and bridge_id = any($2::text[])",
            tenant,
            ids,
        )
        await conn.execute(
            "delete from collaboration_bridges where tenant_id = $1 and id = any($2::text[])",
            tenant,
            ids,
        )
        await conn.execute(
            "delete from clients where tenant_id = $1 and id = any($2::text[])",
            tenant,
            [b["client_id"] for b in bridges],
        )
    return {"bridges": len(ids), "rooms": int(status.split()[-1])}


async def main(mode, tenant, prefix, run_id):
    conn = await connect(tenant)
    try:
        out = await {"shape": shape, "reset": reset, "clear": clear}[mode](
            conn, tenant, prefix, run_id
        )
    finally:
        await conn.close()
    print(json.dumps(out), flush=True)


if __name__ == "__main__":
    asyncio.run(main(*sys.argv[1:5]))
