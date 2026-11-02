export class ApiError extends Error {
  constructor(message, status = 0, uncertain = false, aborted = false) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.uncertain = uncertain;
    this.aborted = aborted;
  }
}

export async function apiRequest(path, {
  method = "GET", token, body, key, signal,
  fetchImpl = globalThis.fetch, timeoutMs = 20000,
} = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, timeoutMs);
  try {
    const response = await fetchImpl(`/api${path}`, {
      method,
      cache: "no-store",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    let data;
    try {
      data = JSON.parse(await response.text());
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid response shape");
    } catch {
      throw new ApiError("We couldn’t read the server’s response. Please try again.", response.status, method === "POST");
    }
    if (!response.ok) {
      const message = response.status === 409 ? "This request conflicts with an earlier payment. Review your activity before starting another."
        : typeof data.error === "string" && !data.error.includes("Idempotency-Key") ? data.error : "Something went wrong. Please try again.";
      throw new ApiError(message,
        response.status, response.status >= 500 || [408, 425, 429].includes(response.status));
    }
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("We couldn’t reach PayFlow. Check your connection and try again.", 0,
      method === "POST", Boolean(signal?.aborted));
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export function createPaymentAttempt(userId, operation, body, createKey = () => crypto.randomUUID()) {
  if (!["deposit", "transfer"].includes(operation)) throw new Error("Unknown payment operation");
  return Object.freeze({ userId, operation, key: createKey(), body: Object.freeze({ ...body }) });
}

export async function sendPayment(attempt, token, options = {}) {
  const result = await apiRequest(`/wallet/${attempt.operation}`, {
    ...options, method: "POST", token, key: attempt.key, body: attempt.body,
  });
  if (typeof result.transaction?.id !== "string" ||
      (attempt.operation === "deposit" ? typeof result.wallet?.balance !== "string" : typeof result.newBalance !== "string")) {
    throw new ApiError("We couldn’t confirm the payment’s result. Check the same payment again.", 200, true);
  }
  return result;
}

export function sessionDeadline(session, lastActivity) {
  return Math.min(Date.parse(session.session.expiresAt), lastActivity + session.session.idleTimeoutSeconds * 1000);
}
