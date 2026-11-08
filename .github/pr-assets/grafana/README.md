# Grafana Console previews

These images show the actual Console connection component and CSS in an isolated local fixture with synthetic data. The fixture disables network callbacks and does not start a Grafana sign-in. The Grafana catalog entry in this PR remains disabled after the live stack-isolation gate failed.

1. `01-empty-stack.png`: an empty stack keeps Connect disabled.
2. `02-url-rejected.png`: a full URL keeps Connect disabled.
3. `03-hostname-valid.png`: a synthetic stack hostname enables Connect in the fixture only.
