"""The trigger that ends a person's sessions when their password or their
server-admin role changes.

A session cookie carries the `users.session_version` it was minted with, and
every authenticated request compares it with the row (`gateway/auth.py`), so
incrementing the column signs the person out everywhere. Most reasons to do
that come through the gateway ("Sign out of all devices"), but the two that
matter most for security also happen outside it: a password is reset and an
operator is demoted by hand, in SQL. A trigger is the one place neither path
can skip.

The migration that installs this carries its own copy, frozen as it was
written; this copy is what `create_all` builds for the tests.
"""

from __future__ import annotations

SESSION_VERSION_FUNCTION_NAME = "switch_bump_session_version"
SESSION_VERSION_TRIGGER_NAME = "users_bump_session_version"

CREATE_SESSION_VERSION_FUNCTION = f"""
CREATE OR REPLACE FUNCTION {SESSION_VERSION_FUNCTION_NAME}() RETURNS trigger AS $$
BEGIN
    IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
        OR (OLD.role = 'admin' AND NEW.role IS DISTINCT FROM 'admin') THEN
        NEW.session_version := OLD.session_version + 1;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql
"""

CREATE_SESSION_VERSION_TRIGGER = f"""
CREATE TRIGGER {SESSION_VERSION_TRIGGER_NAME}
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION {SESSION_VERSION_FUNCTION_NAME}()
"""

DROP_SESSION_VERSION_TRIGGER = (
    f"DROP TRIGGER IF EXISTS {SESSION_VERSION_TRIGGER_NAME} ON users"
)
DROP_SESSION_VERSION_FUNCTION = (
    f"DROP FUNCTION IF EXISTS {SESSION_VERSION_FUNCTION_NAME}()"
)
