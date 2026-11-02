---
name: zoom
description: Search meetings and retrieve meeting summaries, recordings, and transcripts.
---

# Zoom Meetings

Use this connection to find meeting records and retrieve meeting assets including AI summaries, cloud transcripts, and recording metadata.

## Safe defaults

- **Handle meeting records with care**: Meeting transcripts, participant identities, and recorded conversations contain sensitive context. Only query meetings and transcripts directly relevant to the user's inquiry.
- **Read-only operations**: Do not attempt to schedule, modify, or cancel meetings through this connection.
- **Targeted retrieval**: When retrieving meeting summaries or transcripts, summarize the core discussion points and action items rather than dumping full raw audio or large transcript payloads unless asked.
- **Privacy and sharing**: Never share meeting recordings, transcripts, or attendee information outside the room or with third-party endpoints.
