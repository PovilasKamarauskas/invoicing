import {
  allowedOrigins,
  registrationEnabled,
  validateRuntime,
} from './runtime-config';

describe('Public deployment configuration', () => {
  const keys = [
    'APP_ENV',
    'APP_ORIGIN',
    'COOKIE_SECURE',
    'TRUST_PROXY',
    'REGISTRATION_ENABLED',
  ];
  const original = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  beforeEach(() => {
    for (const key of keys) delete process.env[key];
  });
  afterEach(() => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
  it('preserves local registration and restricts local browser origins', () => {
    expect(registrationEnabled()).toBe(true);
    expect(allowedOrigins()).toContain('http://localhost:5173');
    expect(allowedOrigins()).not.toContain('https://untrusted.example');
  });
  it('requires secure, explicit origin/proxy settings and closes production registration by default', () => {
    process.env.APP_ENV = 'production';
    expect(registrationEnabled()).toBe(false);
    expect(() => validateRuntime()).toThrow('APP_ORIGIN is required');
    process.env.APP_ORIGIN = 'http://invoices.example.test';
    expect(() => validateRuntime()).toThrow('HTTPS');
    process.env.APP_ORIGIN = 'https://invoices.example.test';
    expect(() => validateRuntime()).toThrow('COOKIE_SECURE');
    process.env.COOKIE_SECURE = 'true';
    expect(() => validateRuntime()).toThrow('TRUST_PROXY');
    process.env.TRUST_PROXY = 'true';
    expect(validateRuntime()).toEqual(['https://invoices.example.test']);
  });
  it.each([
    'https://invoices.example.test/path',
    'https://user:password@invoices.example.test',
    'https://invoices.example.test?redirect=other',
    'ftp://invoices.example.test',
  ])('rejects a non-origin setting: %s', (origin) => {
    process.env.APP_ORIGIN = origin;
    expect(() => allowedOrigins()).toThrow('origin');
  });
});
