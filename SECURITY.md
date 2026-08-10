# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Report privately through GitHub's **private vulnerability reporting**:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the issue, including steps to reproduce, affected component(s), and
   the impact you believe it has.

This opens a private advisory visible only to you and the maintainers.

We aim to acknowledge a report within **3 business days** and to provide an
initial assessment within **10 business days**. Please give us a reasonable
window to investigate and ship a fix before any public disclosure, and we will
keep you informed of progress.

When reporting, please include where relevant:

- The component and version / commit affected (e.g. `switch-core`, the gateway,
  Switch Console, a collaboration bridge).
- A clear description of the vulnerability and its impact.
- Steps to reproduce or a proof of concept.
- Any suggested remediation.

## Scope

This policy covers the code in this repository: the Switch control plane
(`core/`), the operator gateway (`gateway/`), the Switch Console desktop app
(`dash/`), the connector plugins (`connectors/`), and the deployment assets
(`deploy/`). Vulnerabilities in third-party dependencies should be reported to
the upstream project; if a dependency issue affects Switch specifically, let us
know so we can pull in the fix.
