"""The Session Interaction Contract's server side.

A package of its own rather than more of `ProtocolService`. The contract is a
separate surface with its own versioned prefix, its own error envelope and its
own notion of who is allowed to speak, and `ProtocolService` is already the
place everything else in the agent bridge ended up.
"""
