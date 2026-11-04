-- How an agent's sessions take a message sent while a turn is running: 'steer'
-- joins the running turn where the provider can, 'queue' waits for a turn of
-- its own. Steering is the default, so every agent the upgrade meets steers,
-- as new ones do.
ALTER TABLE `agents` ADD `mid_turn_messages` text DEFAULT 'steer' NOT NULL;