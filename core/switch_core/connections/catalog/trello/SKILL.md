---
name: trello
description: "Manage Trello boards, lists, cards, and team tasks. Read boards and lists before creating, moving, or updating cards."
---

# Trello

Use this skill to inspect, create, organize, and update Trello cards, lists, and boards for collaborative team workflows.

## Guidelines

1. **Read before write**: Always inspect boards (`list_boards`) and lists (`list_lists`) to obtain valid IDs before creating or moving cards.
2. **Safe defaults**: Always verify the destination list and board before creating or moving cards. Require explicit user confirmation before archiving or deleting cards.
3. **Card updates**: When updating card descriptions or checklists, preserve existing context and append updates clearly.

## Capabilities

- **Boards**: List member boards, retrieve board details, members, and custom fields.
- **Lists**: List columns (e.g., Backlog, Doing, Review, Done) on a board.
- **Cards**: Create cards with descriptions, assign members, add labels, and set due dates.
- **Move Cards**: Transition cards between lists across workflow stages.
- **Checklists & Comments**: Add checklists, mark items complete, and post progress comments to cards.
- **Search**: Search cards by name, label, or assigned member across boards.
