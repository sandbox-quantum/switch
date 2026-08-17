/*
 Write an agreement to share usage data back into the row that records it,
 before the default it was stored against changes meaning.

 App settings are persisted as a delta: `SettingsStore.update()` keeps only the
 fields that differ from the default at the moment of writing, and drops the
 rest. While sharing defaulted to on, someone who saw the first-run prompt and
 left it on therefore stored `{"askedAt": <ts>}` and nothing else — their answer
 was recorded by its own absence.

 The default is now off, because what is sent carries a per-install id. That
 turns those rows inside out: with `enabled` missing, they resolve to the new
 default and read as a refusal, and the prompt never returns to ask again
 because `askedAt` is set. The agreement would be lost with no way to tell it
 from a genuine no.

 A row that is missing `enabled` while carrying an `askedAt` can only have been
 written under the old default, so its absent value is recoverable: it was on.
 Rows that name `enabled` explicitly — including every row written from here on
 — already say what they mean and are left alone.
*/
UPDATE app_settings
SET value = json_set(value, '$.enabled', json('true'))
WHERE key = 'telemetry'
  AND json_extract(value, '$.askedAt') IS NOT NULL
  AND json_type(value, '$.enabled') IS NULL;
