import { describe, expect, it } from 'vitest';
import { isSecretTempOf, secretTempPath } from './secret-temp';

describe('secret temporary copies', () => {
  it('recognises the names it hands out, for that file only', () => {
    const temporary = secretTempPath('/w/.switch/agents/a.json');
    const name = temporary.slice('/w/.switch/agents/'.length);

    expect(isSecretTempOf(name, 'a.json')).toBe(true);
    expect(isSecretTempOf(name, 'b.json')).toBe(false);
    expect(isSecretTempOf(name, 'a.jso')).toBe(false);
  });

  it('ignores names that only look like one', () => {
    const uuid = '0b6f1d2e-3c4a-4b5d-8e9f-a0b1c2d3e4f5';
    expect(isSecretTempOf('a.json', 'a.json')).toBe(false);
    expect(isSecretTempOf('a.json.bak', 'a.json')).toBe(false);
    expect(isSecretTempOf(`a.json2.${uuid}`, 'a.json')).toBe(false);
    expect(isSecretTempOf(`a.json.${uuid.toUpperCase()}`, 'a.json')).toBe(false);
    expect(isSecretTempOf(`a.json.${uuid}.x`, 'a.json')).toBe(false);
  });
});
