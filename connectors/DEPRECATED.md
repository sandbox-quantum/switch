# Deprecated: kept only for Switch Console 0.35 and older

Switch Console no longer uses these plugins: every session it (or its
sidecar) runs gets the Switch tools from its own session host and the Switch
skill pushed by Console (`console/packages/plugins/src/switch-skill/SKILL.md`).

These files, and `.claude-plugin/marketplace.json`, stay on the default branch
unchanged so that Consoles which have not updated yet can still install and
update the plugin they expect. They are not maintained, not tested and not
published. Remove them once those Consoles are gone.
