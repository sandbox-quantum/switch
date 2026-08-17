import { describe, expect, it } from 'vitest';
import type { AddressingPolicy } from '@shared/core/switch-servers/switch-servers';
import {
  type AddressingMode,
  addressingModeOf,
  ownerAndMyAgentsPolicy,
  ownerOnlyPolicy,
  policyForMode,
  policyNamesOwner,
} from './owner-policy';

describe('the two owner-scoped shapes', () => {
  it('admits the owner and nobody else', () => {
    expect(ownerOnlyPolicy()).toEqual({
      rules: [
        {
          rooms: '*',
          room_groups: '*',
          users: [],
          agents: [],
          owner: true,
          owner_agents: false,
        },
      ],
    });
  });

  it('adds the owner’s own agents, and only theirs', () => {
    // Symbolic rather than a list of ids: registering another agent must not
    // require going back and editing every policy that should include it.
    expect(ownerAndMyAgentsPolicy().rules[0]).toMatchObject({
      owner: true,
      owner_agents: true,
      agents: [],
    });
  });

  it('differ only in whether the owner’s agents are admitted', () => {
    const [strict] = ownerOnlyPolicy().rules;
    const [withAgents] = ownerAndMyAgentsPolicy().rules;
    expect({ ...strict, owner_agents: true }).toEqual(withAgents);
  });
});

/** A rule set no shortcut can express, so it can only be "Custom rules". */
const HAND_BUILT: AddressingPolicy = {
  rules: [
    { rooms: ['room-1'], room_groups: '*', users: ['user-1'], agents: [], owner: true },
    { rooms: '*', room_groups: ['group-1'], users: [], agents: ['agent-a'] },
  ],
};

describe('policyNamesOwner', () => {
  it('is false for a policy that admits everyone', () => {
    expect(policyNamesOwner(null)).toBe(false);
    expect(policyNamesOwner({ rules: [] })).toBe(false);
  });

  it('is true for both owner-scoped shortcuts', () => {
    expect(policyNamesOwner(ownerOnlyPolicy())).toBe(true);
    expect(policyNamesOwner(ownerAndMyAgentsPolicy())).toBe(true);
  });

  it('is true for a hand-built rule set that names the owner', () => {
    // Not only the shape the chooser calls `owner`: what matters is whether the
    // agent has to recognise its owner at all, and this one does.
    expect(addressingModeOf(HAND_BUILT)).toBe('custom');
    expect(policyNamesOwner(HAND_BUILT)).toBe(true);
  });

  it('is false for a rule that admits only the owner’s agents', () => {
    // This one needs no linked messaging account: an agent sender is
    // recognised by its agent id. Warning about an unlinked account here would
    // be a warning nobody can act on.
    expect(
      policyNamesOwner({
        rules: [{ rooms: '*', room_groups: '*', users: [], agents: [], owner_agents: true }],
      })
    ).toBe(false);
  });

  it('is false for rules that name people rather than the owner', () => {
    expect(
      policyNamesOwner({
        rules: [
          { rooms: '*', room_groups: '*', users: ['user-1'], agents: [], owner: false },
          { rooms: '*', room_groups: '*', users: [], agents: ['agent-a'] },
        ],
      })
    ).toBe(false);
  });
});

describe('addressingModeOf', () => {
  it('reads an absent policy as anyone', () => {
    expect(addressingModeOf(null)).toBe('anyone');
  });

  it('reads a policy with no rules as anyone, as switch-core does', () => {
    expect(addressingModeOf({ rules: [] })).toBe('anyone');
  });

  it('tells the two owner-scoped shapes apart', () => {
    expect(addressingModeOf(ownerOnlyPolicy())).toBe('owner');
    expect(addressingModeOf(ownerAndMyAgentsPolicy())).toBe('ownerAndAgents');
  });

  it('reads a policy stored before owner_agents existed as only-me', () => {
    // An absent key is false server-side. Reading it as the wider choice would
    // silently widen every agent created before this shipped.
    expect(
      addressingModeOf({
        rules: [{ rooms: '*', room_groups: '*', users: [], agents: [], owner: true }],
      })
    ).toBe('owner');
  });

  it('reads owner-plus-named-agents as custom rather than flattening it', () => {
    // The shape earlier builds wrote, now that the shortcut no longer has an
    // agent picker. Calling it "Only me" would drop the names on the next save.
    expect(
      addressingModeOf({
        rules: [{ rooms: '*', room_groups: '*', users: [], agents: ['agent-a'], owner: true }],
      })
    ).toBe('custom');
  });

  it('reads a hand-edited policy as custom', () => {
    expect(addressingModeOf(HAND_BUILT)).toBe('custom');
  });
});

describe('policyForMode', () => {
  const modes: AddressingMode[] = ['ownerAndAgents', 'owner', 'anyone', 'custom'];

  it('round-trips every mode back to itself', () => {
    for (const mode of modes) {
      expect(addressingModeOf(policyForMode(mode, null))).toBe(mode);
    }
  });

  it('round-trips a hand-built policy through custom without touching it', () => {
    expect(addressingModeOf(HAND_BUILT)).toBe('custom');
    expect(policyForMode('custom', HAND_BUILT)).toBe(HAND_BUILT);
  });

  it('opens up to anyone by dropping the policy', () => {
    expect(policyForMode('anyone', HAND_BUILT)).toBeNull();
  });

  it('replaces a hand-built policy when a shortcut is chosen', () => {
    expect(policyForMode('owner', HAND_BUILT)).toEqual(ownerOnlyPolicy());
    expect(policyForMode('ownerAndAgents', HAND_BUILT)).toEqual(ownerAndMyAgentsPolicy());
  });

  it('narrows when only-me is chosen from only-me-and-my-agents', () => {
    expect(policyForMode('owner', ownerAndMyAgentsPolicy())).toEqual(ownerOnlyPolicy());
  });

  it('seeds custom rules from what the shortcut expressed', () => {
    expect(policyForMode('custom', ownerAndMyAgentsPolicy())).toEqual(ownerAndMyAgentsPolicy());
  });

  it('seeds custom rules from what anyone expressed, rather than from nothing', () => {
    const seeded = policyForMode('custom', null);
    expect(seeded).toEqual({
      rules: [
        {
          rooms: '*',
          room_groups: '*',
          users: '*',
          agents: '*',
          owner: false,
          owner_agents: false,
        },
      ],
    });
    expect(addressingModeOf(seeded)).toBe('custom');
  });
});
