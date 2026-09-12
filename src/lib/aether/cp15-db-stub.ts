/**
 * Test-only SQL surface for CP15 HTTP adapter tests.
 * Bound via Symbol.for("aether:cp15-sql") on globalThis.
 */
const SQL_KEY = Symbol.for("aether:cp15-sql");

type QuerySql = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

export function getSql(): Promise<QuerySql> {
  const sql = (globalThis as Record<symbol, QuerySql | undefined>)[SQL_KEY];
  if (!sql) {
    throw new Error("cp15 test sql is not bound");
  }
  return Promise.resolve(sql);
}
