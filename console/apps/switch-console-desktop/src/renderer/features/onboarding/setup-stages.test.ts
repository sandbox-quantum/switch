import { describe, expect, it } from 'vitest';
import { setupStage } from './setup-stages';

describe('setupStage', () => {
  it.each([
    ['Preparing the server…', 0],
    ['Looking for PostgreSQL…', 0],
    ['Downloading PostgreSQL 16…', 0],
    ['Installing switch-core 0.31.0…', 0],
    ['Building the admin pages (first start of this version)…', 0],
    ['Creating the database (PostgreSQL 16)…', 1],
    ['Starting PostgreSQL…', 1],
    ['Importing the Switch database…', 1],
    ['Starting switch-core…', 2],
    ['Waiting for the server to become healthy…', 2],
    ['Signing in…', 3],
  ])('puts “%s” in stage %i', (message, stage) => {
    expect(setupStage(message)).toBe(stage);
  });

  it('knows no stage for a step it has never seen, or for none', () => {
    expect(setupStage('Reticulating splines…')).toBeNull();
    expect(setupStage(null)).toBeNull();
  });
});
