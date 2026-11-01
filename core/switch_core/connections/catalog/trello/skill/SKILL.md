---
name: trello
description: Manage Trello boards, lists, cards, and team tasks. Read boards and lists before creating, moving, or updating cards.
---

# Trello

Use this skill to inspect, create, organize, and update Trello cards, lists, and boards for collaborative team workflows.

## Guidelines

- Always call `get_boards` or `list_lists` to obtain board and list IDs before creating or moving cards — preserve existing context and avoid duplication.
- When moving a card, confirm the destination list ID first.
- Prefer archiving over deleting cards and lists.
- Read card details and custom fields before updating.
- Use labels and due dates purposefully and only when instructed.
- Add comments to cards only when sharing progress is explicitly requested.

## Capabilities

- List all boards, lists, and cards
- Create, update, archive, and move cards between lists
- Add labels, due dates, members, and checklists to cards
- Search across boards
- Post and read comments on cards
- Retrieve board members and their roles
