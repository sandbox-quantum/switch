/*
 CHOO-1426: the base location setting `workspaceProvider` was renamed to
 `locationProvider`. It lives inside the `base_settings_json` blob (not a
 column), so rewrite persisted blobs: move the nested object to the new key and
 drop the old one. Only touch rows that actually carry the old key.
*/
UPDATE location_settings
SET base_settings_json = json_remove(
  json_set(
    base_settings_json,
    '$.locationProvider',
    json(json_extract(base_settings_json, '$.workspaceProvider'))
  ),
  '$.workspaceProvider'
)
WHERE json_type(base_settings_json, '$.workspaceProvider') IS NOT NULL;
