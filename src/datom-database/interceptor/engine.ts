/**
 * Interceptor engine for managing and executing database interceptors
 * Supports before-read, after-read, before-write, and after-write interceptors
 */

import type {
  AfterReadInterceptor,
  BeforeReadInterceptor,
  BeforeWriteInterceptor,
  Interceptor,
} from "./types.js";
import type { Datom, Transaction } from "../../types.js";
import type { DatalogQuery } from "../../datalog/datalog.js";
import type { InterceptorErrorWithName } from "../errors.js";
import type { ReadContext, WriteContext } from "./types.js";

/**
 * Engine for managing and executing database interceptors
 * Interceptors run in registration order and can modify queries, validate transactions,
 * filter results, or perform side effects
 */
export class InterceptorEngine {
  private beforeReadInterceptors: BeforeReadInterceptor[] = [];
  private afterReadInterceptors: AfterReadInterceptor[] = [];
  private beforeWriteInterceptors: BeforeWriteInterceptor[] = [];
  private afterWriteInterceptors: Array<{
    type: "afterWrite";
    name: string;
    execute: (tx: Transaction, ctx: WriteContext) => Promise<void>;
  }> = [];

  /**
   * Register an interceptor
   * @param interceptor The interceptor to register
   * @example
   * engine.register({
   *   type: "beforeWrite",
   *   name: "validate-email",
   *   execute: async (tx, ctx) => {
   *     // Validation logic
   *     return { tx, errors: undefined };
   *   }
   * });
   */
  register(interceptor: Interceptor): void {
    if (interceptor.type === "beforeRead") {
      this.beforeReadInterceptors.push(interceptor);
    } else if (interceptor.type === "afterRead") {
      this.afterReadInterceptors.push(interceptor);
    } else if (interceptor.type === "beforeWrite") {
      this.beforeWriteInterceptors.push(interceptor);
    } else {
      this.afterWriteInterceptors.push(interceptor);
    }
  }

  /**
   * Run before-read interceptors (modify/block query before execution)
   * @param query The datalog query to process
   * @param ctx Read context with database reference and additional data
   * @returns Modified query and any errors
   */
  async runBeforeRead(
    query: DatalogQuery,
    ctx: ReadContext
  ): Promise<{
    query: DatalogQuery;
    errors: InterceptorErrorWithName[];
  }> {
    let result = query;
    const allErrors: InterceptorErrorWithName[] = [];

    for (const interceptor of this.beforeReadInterceptors) {
      const interceptorResult = await interceptor.execute(result, ctx);

      result = interceptorResult.query as DatalogQuery;

      if (interceptorResult.errors && interceptorResult.errors.length > 0) {
        for (const e of interceptorResult.errors) {
          allErrors.push({
            interceptor: interceptor.name,
            message: e.message,
            code: e.code,
            datom: e.datom,
          });
        }
      }

      if (interceptorResult.stopProcessing === true) {
        break;
      }
    }

    return { query: result, errors: allErrors };
  }

  /**
   * Run after-read interceptors (filter/transform results after execution)
   * @param datoms The datoms returned from the query
   * @param ctx Read context with database reference and additional data
   * @returns Filtered/transformed datoms
   */
  async runAfterRead(datoms: Datom[], ctx: ReadContext): Promise<Datom[]> {
    let result = datoms;

    for (const interceptor of this.afterReadInterceptors) {
      result = await interceptor.execute(result, ctx);
    }

    return result;
  }

  /**
   * Run before-write interceptors (validate/augment before commit)
   * @param tx The transaction to process
   * @param ctx Write context with database reference, metadata, and additional data
   * @returns Modified transaction and any errors
   */
  async runBeforeWrite(
    tx: Transaction,
    ctx: WriteContext
  ): Promise<{
    tx: Transaction;
    errors: InterceptorErrorWithName[];
  }> {
    let result = tx;
    const allErrors: InterceptorErrorWithName[] = [];

    for (const interceptor of this.beforeWriteInterceptors) {
      const interceptorResult = await interceptor.execute(result, ctx);

      result = interceptorResult.tx;

      if (interceptorResult.errors && interceptorResult.errors.length > 0) {
        for (const e of interceptorResult.errors) {
          allErrors.push({
            interceptor: interceptor.name,
            message: e.message,
            code: e.code,
            datom: e.datom,
          });
        }
      }

      if (interceptorResult.stopProcessing === true) {
        break;
      }
    }

    return { tx: result, errors: allErrors };
  }

  /**
   * Run after-write interceptors (side effects after commit)
   * Failures in after-write interceptors don't fail the transaction
   * @param tx The committed transaction
   * @param ctx Write context with database reference, metadata, and additional data
   */
  async runAfterWrite(tx: Transaction, ctx: WriteContext): Promise<void> {
    await Promise.allSettled(
      this.afterWriteInterceptors.map((interceptor) =>
        interceptor.execute(tx, ctx).catch((err) => {
          console.error(
            `After-write interceptor "${interceptor.name}" failed:`,
            err
          );
        })
      )
    );
  }
}
