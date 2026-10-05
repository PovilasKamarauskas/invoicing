import type { NestExpressApplication } from '@nestjs/platform-express';

export function allowedOrigins(): string[] {
  const configured = process.env.APP_ORIGIN?.trim();
  if (configured) {
    const url = new URL(configured);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error(
        'APP_ORIGIN must be an HTTP(S) origin without a path or credentials.',
      );
    return [url.origin];
  }
  if (process.env.APP_ENV === 'production')
    throw new Error('APP_ORIGIN is required in production.');
  return [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5174',
  ];
}

export function registrationEnabled(): boolean {
  return process.env.REGISTRATION_ENABLED === undefined
    ? process.env.APP_ENV !== 'production'
    : process.env.REGISTRATION_ENABLED === 'true';
}

export function validateRuntime() {
  const origins = allowedOrigins();
  if (process.env.APP_ENV === 'production') {
    if (
      !origins[0].startsWith('https://') ||
      process.env.COOKIE_SECURE !== 'true'
    )
      throw new Error(
        'Production requires an HTTPS APP_ORIGIN and COOKIE_SECURE=true.',
      );
    if (process.env.TRUST_PROXY !== 'true')
      throw new Error(
        'Production requires TRUST_PROXY=true with the private frontend proxy.',
      );
  }
  return origins;
}

export function configureApplication(app: NestExpressApplication) {
  const origins = validateRuntime();
  app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
  app.disable('x-powered-by');
  app.enableCors({
    origin: origins,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
  });
  app.use(
    (
      _req: unknown,
      res: { setHeader(name: string, value: string): void },
      next: () => void,
    ) => {
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
      next();
    },
  );
}
