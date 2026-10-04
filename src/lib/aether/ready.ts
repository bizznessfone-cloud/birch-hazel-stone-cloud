/**
 * Binary production readiness. One SELECT 1 through the existing SQL client.
 * Failure is HTTP 503 with {"ok":false}. Never echo driver or topology data.
 */

const READY_BODY = {
  true: '{"ok":true}',
  false: '{"ok":false}',
} as const;

export type ReadyDb = {
  query(text: string, params?: unknown[]): Promise<unknown>;
};

export async function readinessResponse(open: () => Promise<ReadyDb>): Promise<Response> {
  try {
    const db = await open();
    await db.query("select 1");
    return ready(true);
  } catch {
    return ready(false);
  }
}

function ready(ok: boolean): Response {
  return new Response(ok ? READY_BODY.true : READY_BODY.false, {
    status: ok ? 200 : 503,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
