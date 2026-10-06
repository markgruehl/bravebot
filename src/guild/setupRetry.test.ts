import { describe, expect, it } from 'vitest';
import { createSetupCooldown } from './setupRetry.js';

describe('createSetupCooldown', () => {
  it('is due before any attempt and again only after the cooldown', () => {
    let t = 1_000;
    const cooldown = createSetupCooldown(60_000, () => t);
    expect(cooldown.due('g1')).toBe(true);
    cooldown.mark('g1');
    expect(cooldown.due('g1')).toBe(false);
    t += 59_999;
    expect(cooldown.due('g1')).toBe(false);
    t += 1;
    expect(cooldown.due('g1')).toBe(true);
  });

  it('tracks guilds independently and can forget them', () => {
    const t = 0;
    const cooldown = createSetupCooldown(60_000, () => t);
    cooldown.mark('g1');
    expect(cooldown.due('g2')).toBe(true);
    cooldown.forget('g1');
    expect(cooldown.due('g1')).toBe(true);
  });
});
