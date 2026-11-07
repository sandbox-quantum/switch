# WhatsApp

Connect Switch rooms to WhatsApp users via the official **WhatsApp Business Cloud API** using your own Meta Business app and phone number.

## Overview

- **Self-Created Mode:** Create a WhatsApp Business app in Meta for Developers and provide your `phone_number_id`, `access_token`, and `app_secret`.
- **Webhooks:** Inbound messages are delivered over Switch's per-connection signed webhook endpoint.
- **24-Hour Customer Service Window:** Free-form responses are allowed within 24 hours of the customer's last message. Messages outside this window raise an explicit explanation rather than silently failing.
- **Replies:** Threading is mapped using WhatsApp context quote-replies (`context.message_id`).

## Setup in Switch Console

1. In the [Meta App Dashboard](https://developers.facebook.com/), create an app of type **Business** and set up the **WhatsApp** product.
2. Note your **Phone Number ID**, **System User Access Token**, and **App Secret**.
3. In Switch Console, go to **Connections** > **Connect a Messaging App** > **WhatsApp**.
4. Enter your credentials and copy the generated Webhook URL and Verify Token to Meta's Webhook settings.
5. Subscribe to the `messages` webhook field.
