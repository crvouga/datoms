/**
 * Database wrapper utility for logging and monitoring database calls
 * Works in both client and server contexts with callback-based hooks
 */

import type { DatomDatabase } from "../datom-database.js";
import type { DatabaseView } from "../views/database-view.js";
import type { WithResult } from "../datom-database.js";

/**
 * Log entry for a database method call
 */
export interface DbCallLog {
    /** Unique identifier for this call */
    id: number;
    /** Timestamp when the call was made */
    timestamp: number;
    /** Name of the method that was called */
    method: string;
    /** Arguments passed to the method */
    args: unknown[];
    /** Result of the call (if successful) */
    result?: unknown;
    /** Error message (if the call failed) */
    error?: string;
    /** Duration of the call in milliseconds */
    duration: number;
}

/**
 * Options for creating a logged database wrapper
 */
export interface LoggedDatabaseOptions {
    /** Called when a method call starts */
    onCallStart?: (method: string, args: unknown[]) => void;
    /** Called when a method call completes successfully */
    onCallComplete?: (log: DbCallLog) => void;
    /** Called when a method call fails */
    onCallError?: (log: DbCallLog) => void;
}

/**
 * Creates a proxy-wrapped database that logs all method calls
 * 
 * @param db - The database instance to wrap
 * @param options - Callback options for logging
 * @returns A wrapped database instance that intercepts and logs all calls
 * 
 * @example
 * ```typescript
 * const loggedDb = createLoggedDatabase(db, {
 *   onCallStart: (method, args) => console.log(`Calling ${method}`, args),
 *   onCallComplete: (log) => console.log(`Completed in ${log.duration}ms`),
 *   onCallError: (log) => console.error(`Error: ${log.error}`)
 * });
 * ```
 */
export function createLoggedDatabase<T extends DatomDatabase>(
    db: T,
    options: LoggedDatabaseOptions = {}
): T {
    const { onCallStart, onCallComplete, onCallError } = options;
    let callIdCounter = 0;

    /**
     * Checks if a value is a DatabaseView instance
     */
    const isDatabaseView = (value: unknown): value is DatabaseView => {
        return (
            value !== null &&
            typeof value === "object" &&
            "query" in value &&
            "datoms" in value &&
            typeof (value as DatabaseView).query === "function" &&
            typeof (value as DatabaseView).datoms === "function"
        );
    };

    /**
     * Wraps a DatabaseView instance recursively
     */
    const wrapDatabaseView = (view: DatabaseView): DatabaseView => {
        return new Proxy(view, {
            get(target, prop) {
                const methodName = String(prop);
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                const originalMethod = Reflect.get(target, prop);

                // Skip Symbol properties
                if (typeof prop === "symbol") {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
                    return originalMethod;
                }

                // If it's not a function, return as-is
                if (typeof originalMethod !== "function") {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
                    return originalMethod;
                }

                // Wrap function calls with logging
                return async (...args: unknown[]) => {
                    const callId = callIdCounter++;
                    const callStartTime = performance.now();
                    const timestamp = Date.now();

                    onCallStart?.(methodName, args);

                    try {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
                        const result = await (originalMethod as (...args: unknown[]) => Promise<unknown>).apply(target, args);
                        const callEndTime = performance.now();
                        const duration = callEndTime - callStartTime;

                        const logEntry: DbCallLog = {
                            id: callId,
                            timestamp,
                            method: methodName,
                            args,
                            result,
                            duration,
                        };

                        onCallComplete?.(logEntry);

                        // If the result is a DatabaseView, wrap it recursively
                        if (isDatabaseView(result)) {
                            return wrapDatabaseView(result);
                        }

                        return result;
                    } catch (err) {
                        const callEndTime = performance.now();
                        const duration = callEndTime - callStartTime;
                        const errorMessage = err instanceof Error ? err.message : String(err);

                        const logEntry: DbCallLog = {
                            id: callId,
                            timestamp,
                            method: methodName,
                            args,
                            error: errorMessage,
                            duration,
                        };

                        onCallError?.(logEntry);
                        throw err;
                    }
                };
            },
        }) as DatabaseView;
    };

    /**
     * Wraps a WithResult to recursively wrap its database views
     */
    const wrapWithResult = (result: WithResult): WithResult => {
        return {
            ...result,
            dbBefore: wrapDatabaseView(result.dbBefore),
            dbAfter: wrapDatabaseView(result.dbAfter),
        };
    };

    return new Proxy(db, {
        get(target, prop) {
            const methodName = String(prop);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            const originalMethod = Reflect.get(target, prop);

            // Skip Symbol properties
            if (typeof prop === "symbol") {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-return
                return originalMethod;
            }

            // Handle special methods that return db instances (asOf, history, since)
            if (prop === "asOf" || prop === "history" || prop === "since") {
                return (...args: unknown[]) => {
                    const callId = callIdCounter++;
                    const callStartTime = performance.now();
                    const timestamp = Date.now();

                    onCallStart?.(methodName, args);

                    try {
                        // These methods are synchronous and return DatabaseView
                        const method = originalMethod as (...args: unknown[]) => DatabaseView;
                        const dbInstance = method.apply(target, args);
                        const callEndTime = performance.now();
                        const duration = callEndTime - callStartTime;

                        const logEntry: DbCallLog = {
                            id: callId,
                            timestamp,
                            method: methodName,
                            args,
                            result: dbInstance,
                            duration,
                        };

                        onCallComplete?.(logEntry);

                        // Wrap the returned DatabaseView recursively
                        return wrapDatabaseView(dbInstance);
                    } catch (err) {
                        const callEndTime = performance.now();
                        const duration = callEndTime - callStartTime;
                        const errorMessage = err instanceof Error ? err.message : String(err);

                        const logEntry: DbCallLog = {
                            id: callId,
                            timestamp,
                            method: methodName,
                            args,
                            error: errorMessage,
                            duration,
                        };

                        onCallError?.(logEntry);
                        throw err;
                    }
                };
            }

            // Handle the `with()` method which returns a Promise<WithResult>
            if (prop === "with") {
                return async (...args: unknown[]) => {
                    const callId = callIdCounter++;
                    const callStartTime = performance.now();
                    const timestamp = Date.now();

                    onCallStart?.(methodName, args);

                    try {
                        const method = originalMethod as (...args: unknown[]) => Promise<WithResult>;
                        const result = await method.apply(target, args);
                        const callEndTime = performance.now();
                        const duration = callEndTime - callStartTime;

                        const logEntry: DbCallLog = {
                            id: callId,
                            timestamp,
                            method: methodName,
                            args,
                            result,
                            duration,
                        };

                        onCallComplete?.(logEntry);

                        // Wrap the WithResult's database views recursively
                        return wrapWithResult(result);
                    } catch (err) {
                        const callEndTime = performance.now();
                        const duration = callEndTime - callStartTime;
                        const errorMessage = err instanceof Error ? err.message : String(err);

                        const logEntry: DbCallLog = {
                            id: callId,
                            timestamp,
                            method: methodName,
                            args,
                            error: errorMessage,
                            duration,
                        };

                        onCallError?.(logEntry);
                        throw err;
                    }
                };
            }

            // If it's not a function, return as-is (for properties)
            if (typeof originalMethod !== "function") {
                return originalMethod;
            }

            // Wrap all other function calls with logging
            return async (...args: unknown[]) => {
                const callId = callIdCounter++;
                const callStartTime = performance.now();
                const timestamp = Date.now();

                onCallStart?.(methodName, args);

                try {
                    const result = await (originalMethod as (...args: unknown[]) => Promise<unknown>).apply(target, args);
                    const callEndTime = performance.now();
                    const duration = callEndTime - callStartTime;

                    const logEntry: DbCallLog = {
                        id: callId,
                        timestamp,
                        method: methodName,
                        args,
                        result,
                        duration,
                    };

                    onCallComplete?.(logEntry);

                    // If the result is a DatabaseView, wrap it recursively
                    if (isDatabaseView(result)) {
                        return wrapDatabaseView(result);
                    }

                    return result;
                } catch (err) {
                    const callEndTime = performance.now();
                    const duration = callEndTime - callStartTime;
                    const errorMessage = err instanceof Error ? err.message : String(err);

                    const logEntry: DbCallLog = {
                        id: callId,
                        timestamp,
                        method: methodName,
                        args,
                        error: errorMessage,
                        duration,
                    };

                    onCallError?.(logEntry);
                    throw err;
                }
            };
        },
    }) as T;
}
