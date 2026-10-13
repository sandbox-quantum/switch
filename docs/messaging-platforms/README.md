# Messaging platform pages

One page per platform added through
[Add a messaging platform](../contributing/add-a-messaging-platform.md), named
`<key>.md` after the platform's key. Each one tells an operator how to connect
the platform: what to create on the platform side, the permissions it needs,
what each connection field means and what the platform can't do.

The platforms Switch shipped with are documented on the published docs site,
under [Deploy → Messaging apps](https://docs.flintai.dev/flintai/switch/deploy/messaging-apps).
A page here moves there once it's published, and the adapter's `docs_slug` is
then set so Console links to it.
