import { describe, expect, it } from 'vitest';
import { BUDDY_ICON_URL, isBuddyIconUrl, readsAsSwitchBuddy } from './switch-buddy';

describe('isBuddyIconUrl', () => {
  it('recognises the buddy’s picture whatever query or fragment is added', () => {
    expect(isBuddyIconUrl(BUDDY_ICON_URL)).toBe(true);
    expect(isBuddyIconUrl(`${BUDDY_ICON_URL}?v=1`)).toBe(true);
    expect(isBuddyIconUrl(`${BUDDY_ICON_URL}#face`)).toBe(true);
    expect(isBuddyIconUrl(`${BUDDY_ICON_URL}?raw=true#x`)).toBe(true);
  });

  it('recognises the same address written another way', () => {
    expect(isBuddyIconUrl(BUDDY_ICON_URL.replace('https:', 'http:'))).toBe(true);
    expect(
      isBuddyIconUrl(BUDDY_ICON_URL.replace('raw.githubusercontent', 'RAW.GitHubUserContent'))
    ).toBe(true);
    expect(isBuddyIconUrl(BUDDY_ICON_URL.replace('sandbox-quantum', 'Sandbox-Quantum'))).toBe(true);
    expect(isBuddyIconUrl(BUDDY_ICON_URL.replace('switch-buddy.png', 'switch%2Dbuddy.png'))).toBe(
      true
    );
    expect(isBuddyIconUrl(BUDDY_ICON_URL.replace('/assets/', '//assets/'))).toBe(true);
    expect(isBuddyIconUrl(` ${BUDDY_ICON_URL} `)).toBe(true);
  });

  it('does not recognise another address, nor anything that is not a web URL', () => {
    expect(isBuddyIconUrl(null)).toBe(false);
    expect(isBuddyIconUrl('')).toBe(false);
    expect(isBuddyIconUrl('not a url')).toBe(false);
    expect(isBuddyIconUrl('https://example.com/switch-buddy.png')).toBe(false);
    expect(isBuddyIconUrl(BUDDY_ICON_URL.replace('/main/', '/other/'))).toBe(false);
    expect(isBuddyIconUrl(BUDDY_ICON_URL.replace('https:', 'ftp:'))).toBe(false);
    expect(isBuddyIconUrl(BUDDY_ICON_URL.replace('switch-buddy.png', 'switch%ZZbuddy.png'))).toBe(
      false
    );
  });
});

describe('readsAsSwitchBuddy', () => {
  it('reads the plain spellings', () => {
    for (const name of [
      'switch-buddy',
      'Switch Buddy',
      'SWITCH_BUDDY',
      'Your switch-buddy',
      'swítch-buddy',
    ])
      expect(readsAsSwitchBuddy(name), name).toBe(true);
  });

  it('reads Cyrillic and Greek letters that look Latin as the Latin ones', () => {
    for (const name of [
      'Swіtch Buddy', // Cyrillic і
      'Ѕwitch Buddy', // Cyrillic Ѕ
      'Switсh Buddy', // Cyrillic с
      'Switch Вuddy', // Cyrillic В
      'Switch Buddу', // Cyrillic у
      'Switch Buԁԁy', // Cyrillic ԁ
      'SԜITCH BUDDY', // Cyrillic Ԝ
      'SWITCΗ BUDDΥ', // Greek Η and Υ
      'Switch Bυddy', // Greek υ
      'ѕԝітсһ-вυԁԁу', // every letter another script's
    ])
      expect(readsAsSwitchBuddy(name), name).toBe(true);
  });

  it('reads the other common stand-ins', () => {
    for (const name of [
      'Swltch Buddy', // l for i
      'Sw1tch Buddy', // 1 for i
      'SWITCH BUDDY'.replace('I', 'ı'), // dotless i
      'Svvitch Buddy', // vv for w
      'ꜱᴡɪᴛᴄʜ ʙᴜᴅᴅʏ', // small capitals
      'Ｓｗｉｔｃｈ Ｂｕｄｄｙ', // fullwidth, which NFKD folds
      'Switch​Buddy', // a zero-width space
    ])
      expect(readsAsSwitchBuddy(name), name).toBe(true);
  });

  it('leaves names that do not read as switch-buddy alone', () => {
    for (const name of ['helper', 'Switch Helper', 'Buddy', 'Deploy Bot', 'Помощник', 'Βοηθός'])
      expect(readsAsSwitchBuddy(name), name).toBe(false);
  });
});
