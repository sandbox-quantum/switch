"""Chats: a gateway user taking part in Switch rooms as themselves.

A person reaches a room from Switch Console through a `member` client, one per
user per tenant, linked to their gateway user by `clients.user_id`.
"""

MEMBER_CLIENT_TYPE = "member"
