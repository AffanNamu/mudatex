import { describe, expect, it } from 'vitest';
import { buildRuntimeConfig, contentSecurityPolicy, injectCsp } from './write-runtime-config.mjs';

const good = { API_URL: 'https://api.example.com/', SUPABASE_URL: 'https://xdgjomvsbjldmejwwoyb.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abc-123_XYZ' };

describe('buildRuntimeConfig', () => {
  it('writes the settings and allows only the API and the Supabase project', () => {
    const c = buildRuntimeConfig(good);
    expect(c.configJs).toContain('apiUrl: "https://api.example.com"');
    expect(c.configJs).toContain('supabaseKey: "sb_publishable_abc-123_XYZ"');
    expect(c.connectOrigins).toEqual(['https://api.example.com', 'https://xdgjomvsbjldmejwwoyb.supabase.co']);
  });
  it('works without Supabase (development sign-in) and with only the API', () => {
    const c = buildRuntimeConfig({ API_URL: 'http://localhost:3000' });
    expect(c.configJs).toContain('supabaseUrl: ""');
    expect(c.connectOrigins).toEqual(['http://localhost:3000']);
  });
  it('refuses missing, half-set, insecure, secret or script-bearing values', () => {
    expect(() => buildRuntimeConfig({})).toThrow(/API_URL/);
    expect(() => buildRuntimeConfig({ ...good, SUPABASE_PUBLISHABLE_KEY: '' })).toThrow(/both/);
    expect(() => buildRuntimeConfig({ ...good, SUPABASE_URL: 'http://x.supabase.co' })).toThrow(/https/);
    expect(() => buildRuntimeConfig({ ...good, SUPABASE_PUBLISHABLE_KEY: 'sb_secret_zzz' })).toThrow(/secret/);
    expect(() => buildRuntimeConfig({ ...good, API_URL: 'https://a.com";alert(1)//' })).toThrow(/not allowed/);
    expect(() => buildRuntimeConfig({ ...good, API_URL: 'ftp://a.com' })).toThrow(/start with/);
  });
});

describe('injectCsp', () => {
  const html = '<!doctype html><html><head>\n    <meta charset="UTF-8" />\n  </head><body></body></html>';
  it('adds the policy first in the head, and replaces rather than stacks on a second run', () => {
    const policy = contentSecurityPolicy(['https://api.example.com']);
    const once = injectCsp(html, policy);
    expect(once).toMatch(/<head>\s*<meta http-equiv="Content-Security-Policy"/);
    expect(once).toContain("connect-src 'self' https://api.example.com");
    const twice = injectCsp(once, policy);
    expect(twice.match(/Content-Security-Policy/g)).toHaveLength(1);
  });
  it("never allows scripts or styles from anywhere but the site itself", () => {
    const p = contentSecurityPolicy(['https://a.example']);
    expect(p).toContain("script-src 'self';");
    expect(p).not.toContain('unsafe');
  });
});
