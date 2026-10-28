"""Delete what hangs off a room with the room.

The rows that attach agents, references, documents, packages and skills to a
room, and the room's tasks, now go with it, as its messages and roles already
did.
"""

from alembic import op

revision: str = "b7e2f4a91c35"
down_revision = "a4c1e7b93d20"
branch_labels = None
depends_on = None

# (constraint, table) for every foreign key from a room's dependents to the room.
_ROOM_KEYS = [
    ("fk_room_agents_room", "room_agents"),
    ("fk_room_skills_room", "room_skills"),
    ("fk_room_references_room", "room_references"),
    ("fk_room_documents_room", "room_documents"),
    ("fk_room_packages_room", "room_packages"),
    ("fk_tasks_room", "tasks"),
]


def _recreate(ondelete: str | None) -> None:
    for name, table in _ROOM_KEYS:
        op.drop_constraint(name, table, type_="foreignkey")
        op.create_foreign_key(
            name,
            table,
            "rooms",
            ["tenant_id", "room_id"],
            ["tenant_id", "id"],
            ondelete=ondelete,
        )


def upgrade() -> None:
    _recreate("CASCADE")


def downgrade() -> None:
    _recreate(None)
