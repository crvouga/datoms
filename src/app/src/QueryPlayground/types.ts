/**
 * Log entry for a database operation (query or transact)
 * Owned by the query editor, not the database wrapper
 */
export interface QueryEditorLog {
    /** Unique identifier for this call */
    id: number;
    /** Timestamp when the call was made */
    timestamp: number;
    /** Name of the method that was called */
    method: "query" | "transact";
    /** Arguments passed to the method */
    args: unknown[];
    /** Result of the call (if successful) */
    result?: unknown;
    /** Error message (if the call failed) */
    error?: string;
    /** Duration of the call in milliseconds */
    duration: number;
}
