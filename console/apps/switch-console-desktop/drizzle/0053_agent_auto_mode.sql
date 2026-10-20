-- Auto mode: the provider's own automatic review, where safe actions run and
-- risky ones still ask. Agents that predate it keep the behaviour they had, so
-- the column defaults off; new agents are created with it on by the code that
-- creates them.
ALTER TABLE `agents` ADD `auto_mode` integer DEFAULT false NOT NULL;
