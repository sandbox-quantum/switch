# Server keys and rotation

switch-core signs and encrypts with keys derived from `SECRET_KEYS`. This page
covers what the keys protect, how to move a deployment onto them from
`JWT_SECRET_KEY`, and how to rotate them. The code is `core/switch_core/keys.py`
and `core/switch_core/db/key_rotation.py`.

## What the keys protect

`SECRET_KEYS` holds master keys, `<id>:<secret>` comma-separated, current
first. Each secret is at least 32 characters. Nothing uses a master key
directly: each purpose gets its own key, derived with HKDF under a label naming
the purpose, so a key that leaks from one use does not open another.

| Purpose | Kind | Lifetime | After a rotation |
|---|---|---|---|
| Gateway session (`switch_auth` cookie) | signed JWT, `kid` header | 24 hours | verified with the key its `kid` names |
| OIDC login cookie | signed cookie | one login round trip (10 minutes) | current key only; a login in progress at the moment of rotation starts again |
| Messaging install state | signed token | one install round trip | verified with any key in `SECRET_KEYS` |
| Mattermost card buttons | signed context in posted messages | as long as the post | verified with any key in `SECRET_KEYS` |
| Stored credentials: API keys, hosted-install bot tokens, bridge and connector configs | encrypted, value names its key | until changed | re-encrypted under the current key at boot |

The first key is used for everything new. Older keys only verify and decrypt.

## Moving from `JWT_SECRET_KEY`

Before `SECRET_KEYS`, one secret did all of the above. It is now legacy: while
`JWT_SECRET_KEY` is set, it still decrypts values and verifies signatures made
before the upgrade, exactly as they were made.

1. Generate a key and add it as `SECRET_KEYS`, keeping `JWT_SECRET_KEY` set:

   ```bash
   echo "$(date +%Y%m):$(openssl rand -hex 32)"
   ```

   In the Helm chart this is `secrets.secretKeys` (or a `SECRET_KEYS` key in
   `secrets.existingSecret`). Store it in your secrets manager. Every
   environment gets its own.
2. Deploy. On boot, switch-core re-encrypts every stored credential under the
   new key and logs how many it rewrote. Sessions signed before the upgrade
   stay valid until they expire, and buttons on existing Mattermost cards keep
   working. The Helm chart replaces switch-core rather than rolling it, so
   two versions never serve at once. Where they do (several replicas updated
   one by one), a replica still on the previous version cannot verify a
   session the new version signed, so someone who signs in mid-rollout may be
   asked to sign in once more.

   **This step is one-way.** Once the new version has booted, stored
   credentials are encrypted in a format the previous version cannot read, so
   rolling switch-core back would leave it unable to open bridge tokens and
   other stored secrets. The only way back is to restore a database backup
   taken before the upgrade, losing anything written since. Take that backup
   before deploying.
3. When you are ready, remove `JWT_SECRET_KEY` and deploy again. Sessions from
   before step 2 end (people sign in again) and buttons on Mattermost cards
   posted before step 2 stop working; stored credentials are unaffected,
   because step 2 re-encrypted them.

A boot that finds a stored value no configured key opens fails rather than
continuing. That is a key removed too early: put it back.

## Rotating

Rotation takes two deploys, so that where replicas are updated one by one, no
replica is handed a session signed with a key it does not have yet. With the
Helm chart, which replaces switch-core in one step, step 1 is still what keeps
the old key available for decrypting and verifying.

1. Generate a new key and add it **after** the current one:
   `SECRET_KEYS=202610:<old>,202611:<new>`. Deploy. Every replica can now
   verify and decrypt with the new key; nothing uses it yet.
2. Move the new key **first**: `SECRET_KEYS=202611:<new>,202610:<old>`.
   Deploy. New sessions, signatures and encrypted values use the new key, and
   the boot re-encrypts stored credentials under it.
3. Wait at least 24 hours, so sessions signed with the old key have expired.
4. Remove the old key and deploy. Buttons on Mattermost cards posted before
   step 2 stop working; nothing else is affected.

Rotate on a schedule, and at once if a key may have leaked. For a suspected
leak, skip step 1 and the wait: deploy `<new>,<old>`, check the boot log
reports the re-encryption, then deploy `<new>` alone straight away. Stored
credentials need the old key once to be re-encrypted; until the second deploy,
sessions signed with the old key still verify, so keep that window short.
Removing the old key ends every session and stops every Mattermost button
posted before, which is the point.

## Ids

A key id is 1–32 letters, digits, `-` or `_`. It is stored in every encrypted
value and every session token, so it must not change while the key is in use.
A date (`202611`) makes the age of a key obvious.
