import { describe, expect, it } from 'vitest';
import { catalogData } from './catalog';

describe('MCP catalog', () => {
  it('points Atlassian at the v2 endpoint (v1/authv2 is removed on 2027-03-01)', () => {
    // Must match core/switch_core/connections/catalog/atlassian/connection.yaml.
    expect(catalogData.atlassian.config.url).toBe('https://mcp.atlassian.com/v2/mcp');
  });

  it('has no entry on a deprecated Atlassian v1 endpoint', () => {
    const v1 = Object.entries(catalogData)
      .filter(([, entry]) => String(entry.config.url ?? '').includes('mcp.atlassian.com/v1/'))
      .map(([key]) => key);
    expect(v1).toEqual([]);
  });
});
