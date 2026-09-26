import { describe, expect, it } from 'vitest';
import { publicSettings, readConfig } from '../server/config.js';

describe('backend configuration', () => {
  it('keeps credentials out of public settings', () => {
    const config = readConfig({ STARK_API_KEY: 'private-test-value', STARK_BASE_URL: 'https://provider.example/v1/' });
    expect(config.baseUrl).toBe('https://provider.example/v1');
    expect(publicSettings(config).configured).toBe(true);
    expect(JSON.stringify(publicSettings(config))).not.toContain('private-test-value');
    expect(JSON.stringify(publicSettings(config))).not.toContain('provider.example');
  });
  it('rejects unsafe listener settings and invalid budgets', () => {
    expect(() => readConfig({ HOST: '0.0.0.0' })).toThrow('loopback');
    expect(() => readConfig({ TOKENS_PER_MINUTE: '-1' })).toThrow('positive integer');
    expect(() => readConfig({ STARK_BASE_URL: 'https://user:secret@example.com/v1' })).toThrow('without credentials');
  });
});
