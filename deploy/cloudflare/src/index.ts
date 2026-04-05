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
  // Worker vars (non-sensitive)
  FRONTEND_ORIGIN: string;
  CORS_ALLOWED_ORIGINS: string;
  GOOGLE_REDIRECT_URI: string;
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
          RESEND_API_KEY: "",
          GOOGLE_CLIENT_ID: "",
          GOOGLE_CLIENT_SECRET: "",
          GOOGLE_REDIRECT_URI: env.GOOGLE_REDIRECT_URI,
        },
      });
      return backend.fetch(request);
    }

    return env.FRONTEND_WORKER.fetch(request);
  },
} satisfies ExportedHandler<Env>;
