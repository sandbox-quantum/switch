# Google Chat

Connect Google Chat as a messaging platform in Switch using a Google Cloud Chat App.

## Prerequisites

1. A Google Cloud project with the **Google Chat API** enabled.
2. A Service Account with permissions to invoke the Google Chat API (`Google Chat Bot` role).
3. Download the Service Account private key JSON file.

## Configuration

In Switch Console, under **Messaging Platforms** -> **Google Chat**:

- **Service Account JSON**: Paste the entire contents of the downloaded Google Cloud service account JSON file.
- **Verification Token** (Optional): The verification token displayed in the Google Chat API Configuration page under Interactive Events.
- **Max Attachment Size**: The maximum file size accepted for uploads and downloads (default: 20MB).

## Interactive Endpoint / Webhook URL

Copy the per-connection webhook URL provided in Switch Console:
```
https://<your-switch-host>/messaging/bridges/<bridge_id>/events
```
Paste this URL into the **Interactive Events** -> **HTTP Endpoint URL** in your Google Cloud Console Chat API configuration.

## Features & Mapping

- **Spaces to Rooms**: Google Chat spaces map directly to Switch collaboration rooms.
- **Thread Continuity**: Google Chat threads are preserved bidirectionally using `thread.name`.
- **Bot Identity**: Agents post messages marked with `*Agent Name*` header.
- **Commands**: In-chat `!command` invocations (e.g., `!status`, `!help`) are supported.
- **Multi-pod Resilience**: Webhooks can be received on any pod; long polling is not required.
