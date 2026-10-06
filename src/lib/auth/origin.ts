import { ApiError } from "@/lib/api/errors";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence in depth next to `SameSite=Lax` (docs/API_SPEC.md §1): every state-changing request must carry an
 * `Origin` header equal to this deployment's origin. A missing header, `null` or any other origin is refused.
 */
export function assertSameOrigin(request: Request, appOrigin: string): void {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return;
  const origin = request.headers.get("origin");
  let expected: string;
  try {
    expected = new URL(appOrigin).origin;
  } catch {
    throw new ApiError("SERVICE_UNAVAILABLE", "Temporarily unavailable. Please retry.");
  }
  if (origin !== expected) {
    throw new ApiError("FORBIDDEN", "Request origin is not allowed.");
  }
}
