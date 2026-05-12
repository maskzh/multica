import { Container, getContainer } from "@cloudflare/containers";

// Backend: Go server (port 8080)
// manualStart = true so we can inject secrets via start({ envVars })
export class BackendContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "10m";
  manualStart = true;
  enableInternet = true;
}

interface Env {
  BACKEND: DurableObjectNamespace<BackendContainer>;
  FRONTEND_WORKER: Fetcher;
  // Worker secrets — set via: wrangler secret put <NAME>
  DATABASE_URL: string;
  JWT_SECRET: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  // Worker vars (non-sensitive)
  APP_ENV: string;
  FRONTEND_ORIGIN: string;
  CORS_ALLOWED_ORIGINS: string;
  GOOGLE_REDIRECT_URI: string;
  S3_BUCKET: string;
  S3_REGION: string;
  AWS_ENDPOINT_URL: string;
  CLOUDFRONT_DOMAIN: string;
}

const BACKEND_PREFIXES = ["/api/", "/auth/", "/health"];
const BACKEND_EXACT = ["/ws"];

function isBackendPath(pathname: string): boolean {
  return (
    BACKEND_EXACT.includes(pathname) ||
    BACKEND_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

function buildEnvVars(env: Env) {
  return {
    PORT: "8080",
    LOG_LEVEL: "info",
    APP_ENV: env.APP_ENV,
    DATABASE_URL: env.DATABASE_URL,
    JWT_SECRET: env.JWT_SECRET,
    FRONTEND_ORIGIN: env.FRONTEND_ORIGIN,
    CORS_ALLOWED_ORIGINS: env.CORS_ALLOWED_ORIGINS,
    S3_BUCKET: env.S3_BUCKET,
    S3_REGION: env.S3_REGION,
    AWS_ENDPOINT_URL: env.AWS_ENDPOINT_URL,
    CLOUDFRONT_DOMAIN: env.CLOUDFRONT_DOMAIN,
    AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
  };
}

// Per-isolate start memoization. Awaiting backend.start() on every request
// serializes through the DurableObject's input gate — under fan-out (issues
// page mounts ~17 parallel /api/* calls), this manifests as every request
// blocking ~15s until the queue drains. Once start() has resolved in this
// isolate, the container is running; calling it again is wasted work.
let startedInThisIsolate: Promise<void> | null = null;

function ensureStarted(
  backend: ReturnType<typeof getContainer<BackendContainer>>,
  env: Env,
): Promise<void> {
  startedInThisIsolate ??= backend.start({ envVars: buildEnvVars(env) }).catch(
    (err) => {
      // On failure, drop the cached promise so the next request retries
      // instead of inheriting a permanently-rejected state.
      startedInThisIsolate = null;
      throw err;
    },
  );
  return startedInThisIsolate;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (isBackendPath(pathname)) {
      const backend = getContainer(env.BACKEND, "main");
      await ensureStarted(backend, env);
      return backend.fetch(request);
    }

    // Speculatively warm backend.start() in the background while HTML/JS
    // download. ensureStarted dedupes per isolate, so when the page's client
    // JS fires /api/* a moment later, that request's `await ensureStarted`
    // joins the same in-flight promise instead of starting fresh.
    ctx.waitUntil(ensureStarted(getContainer(env.BACKEND, "main"), env));

    return env.FRONTEND_WORKER.fetch(request);
  },
} satisfies ExportedHandler<Env>;
