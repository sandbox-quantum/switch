# Connection logos

Brand logos shown on the Connections grid, one file per connection catalog
slug. All logos are trademarks of their respective owners and are used only to
identify the service a connection integrates with. Their use does not imply
endorsement by, or affiliation with, the owner.

The files are vendored so the app renders them offline. Each was reduced to its
`viewBox` and drawing paths: no scripts, external references, metadata or
embedded raster data. The single-colour marks draw in `currentColor`, and
`connection-icon.tsx` gives each its brand colour, switching to the brand's
one-colour black or white version on the theme where the colour would not
stand out from the tile.

All files fetched 2026-09-29.

| File | Brand | Source | License / terms | Colour |
|---|---|---|---|---|
| `github.svg` | GitHub | [Simple Icons](https://simpleicons.org) 16.33.0, `github` | CC0-1.0 ([Simple Icons disclaimer](https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md)); brand guidelines https://github.com/logos | theme foreground |
| `jira.svg` | Jira | Simple Icons 16.33.0, `jira` | CC0-1.0; guidelines https://atlassian.design/foundations/logos/ | `#0052CC`, white in dark theme |
| `bitbucket.svg` | Bitbucket | Simple Icons 16.33.0, `bitbucket` | CC0-1.0; guidelines https://atlassian.design/foundations/logos/ | `#0052CC`, white in dark theme |
| `asana.svg` | Asana | Simple Icons 16.33.0, `asana` | CC0-1.0; guidelines https://asana.com/brand | `#F06A6A` |
| `gitlab.svg` | GitLab | Simple Icons 16.33.0, `gitlab` | CC0-1.0; guidelines https://about.gitlab.com/press/press-kit/ | `#FC6D26` |
| `google-workspace.svg` | Google | Simple Icons 16.33.0, `google` | CC0-1.0; guidelines https://about.google/brand-resource-center/brand-elements/ | `#4285F4` |
| `datadog.svg` | Datadog | Simple Icons 16.33.0, `datadog` | CC0-1.0; guidelines https://www.datadoghq.com/about/resources/ | `#632CA6`, white in dark theme |
| `new-relic.svg` | New Relic | Simple Icons 16.33.0, `newrelic` | CC0-1.0; guidelines https://newrelic.com/about/media-assets | black in light theme, `#1CE783` in dark theme |
| `notion.svg` | Notion | Simple Icons 16.33.0, `notion` | CC0-1.0 | theme foreground |
| `linear.svg` | Linear | Simple Icons 16.33.0, `linear` | CC0-1.0 | `#5E6AD2` |
| `box.svg` | Box | Simple Icons 16.33.0, `box` | CC0-1.0; guidelines https://www.box.com/en-gb/about-us/press | `#0061D5`, white in dark theme |
| `vercel.svg` | Vercel | Simple Icons 16.33.0, `vercel` | CC0-1.0; guidelines https://vercel.com/geist/brands | theme foreground |
| `canva.svg` | Canva | Canva "Icon logo" from https://www.canva.dev/assets/connect/Canva-logos.zip | Canva Connect brand guidelines (https://www.canva.dev/docs/connect/guidelines/brand/) permit the unmodified icon logo in an integration's UI; gradient ids renamed only | full colour, unmodified |

Simple Icons' CC0 dedication covers the drawings; it does not grant any
trademark rights, which remain with the owners.

## Vendor-supplied logos

These two are the owners' own files rather than Simple Icons drawings (Simple
Icons no longer carries either mark). Both are full colour and unmodified apart
from the hygiene above: `microsoft-365.svg` had its gradient ids renamed and its
`viewBox` cropped from `0 0 48 48` to the artwork (`4 2 40 44`) so it sits at
the same size as the other logos; `salesforce.svg` had its `<style>` classes
written out as the equivalent `fill` attributes and its ids removed.

- **Microsoft 365** (`microsoft-365.svg`): the Microsoft 365 app icon,
  `m365_48x1.svg` from Microsoft's Fluent UI brand-icon CDN,
  https://res.cdn.office.net/files/fabric-cdn-prod_20240129.001/assets/brand-icons/product/svg/m365_48x1.svg
  (byte-identical at
  https://res-1.cdn.office.net/files/fabric-cdn-prod_20230815.002/assets/brand-icons/product/svg/m365_48x1.svg).
  Fetched 2026-09-29. Vendor permission has not been verified; trademark of its
  owner. Terms: Microsoft's Trademark and Brand Guidelines
  (https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks).
- **Salesforce** (`salesforce.svg`): the Salesforce cloud logo shown in the
  header of https://www.salesforce.com/, served from Salesforce's own asset
  domain at
  https://wp.sfdcdigital.com/en-us/wp-content/uploads/sites/4/2024/11/logo-salesforce.svg.
  Fetched 2026-09-29. Vendor permission has not been verified; trademark of its
  owner. Terms: Salesforce's Trademark & Copyright Usage Guidelines
  (https://www.salesforce.com/company/legal/intellectual/tmcusageguidelines/).
