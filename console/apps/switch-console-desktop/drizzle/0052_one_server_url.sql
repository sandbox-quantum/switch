-- One address per server instead of a gateway address and an API address.
--
-- The address kept is the API's. It is the one every agent's credentials, every
-- controller and every sidecar already point at, on this machine and on remote
-- hosts, so nothing outside this table has to be rewritten; and switch-core
-- answers the management API under `/gateway` on it too. The id is untouched,
-- so workspaces, agents, saved sign-ins and view state all still match.
--
-- The gateway address survives only where it differed, as `dashboard_url`: the
-- place to open dashboard pages until the server serves its own dashboard. A
-- server registered with one address for both (Switch Cloud, a single-host
-- ingress) gets null there and nothing changes for it.
--
-- The unique index goes with the gateway address and is not recreated on the
-- API address: two rows may already share one, and refusing them here would
-- stop the app from starting. Adding a server refuses a duplicate instead.
ALTER TABLE `switch_servers` RENAME COLUMN "api_url" TO "url";--> statement-breakpoint
DROP INDEX `idx_switch_servers_gateway_url`;--> statement-breakpoint
ALTER TABLE `switch_servers` ADD `dashboard_url` text;--> statement-breakpoint
UPDATE `switch_servers` SET `dashboard_url` = rtrim(`gateway_url`, '/')
	WHERE lower(rtrim(`gateway_url`, '/')) <> lower(rtrim(`url`, '/'));--> statement-breakpoint
ALTER TABLE `switch_servers` DROP COLUMN `gateway_url`;
