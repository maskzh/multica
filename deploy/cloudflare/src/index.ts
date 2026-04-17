import { Container, getContainer } from "@cloudflare/containers";

// Backend: Go server (port 8080)
// manualStart = true so we can inject secrets via start({ envVars })
export class BackendContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (isBackendPath(pathname)) {
      const backend = getContainer(env.BACKEND, "main");
      // start() is idempotent — no-op if container is already running
      await backend.start({
        envVars: {
          PORT: "8080",
          LOG_LEVEL: "info",
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
        },
      });
      return backend.fetch(request);
    }

    return env.FRONTEND_WORKER.fetch(request);
  },
} satisfies ExportedHandler<Env>;
