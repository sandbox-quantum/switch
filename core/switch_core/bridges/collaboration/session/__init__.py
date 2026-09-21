"""The session projection: what a messaging platform is allowed to show.

Between the session interaction contract and the collaboration adapters sits a
platform-neutral layer that holds one session's state, decides what a room may
see, and hands each platform a rendering of it. This package is that layer.

It is new, and it runs alongside the runtime-state path in
`bridges/collaboration/adapter.py` rather than replacing it: a connector that
cannot speak the contract still gets the old indicator.
"""
