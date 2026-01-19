/**
 * File system database implementation
 * Uses composition with InMemoryDatomDatabase to add file system persistence
 * Loads datoms from a CSV file on initialize() and persists after every transaction
 */

import type { DatalogQuery } from "../../datalog/datalog.js";
import type { Datom, DatomInput, TransactionId, Value } from "../../datoms.js";
import type { EntityId } from "../../entity-id.js";
import type { Transaction } from "../../types.js";
import type { Hook } from "../hook/hook.js";
import type { DatomDatabase, WithResult } from "../datom-database.js";
import type {
  DatomsQuery,
  DatomsResultEnvelope,
  QueryResult,
  QueryResultEnvelope,
} from "../views/database-view.js";
import type { DatabaseView } from "../views/database-view.js";
import { InMemoryDatomDatabase } from "../in-memory/in-memory-datom-database.js";

export interface FileSystemDatomDatabaseOptions {
  /** Path to the CSV file for persistence (default: "datoms.csv") */
  filePath: string;
}

/**
 * File system database implementation
 * Uses composition with InMemoryDatomDatabase for all query and transaction logic,
 * but adds file system persistence for durability
 */
export class FileSystemDatomDatabase implements DatomDatabase {
  private _memoryDb: InMemoryDatomDatabase;
  private readonly filePath: string;

  constructor(options: FileSystemDatomDatabaseOptions) {
    this.filePath = options.filePath;
    // Start with empty array, will be loaded in initialize()
    this._memoryDb = new InMemoryDatomDatabase([]);
  }

  /**
   * Access to hooks (delegated to memory database)
   */
  get hooks() {
    return this._memoryDb.hooks;
  }

  /**
   * Initialize the database by loading datoms from the file system
   * Creates the CSV file with header if it doesn't exist
   */
  async initialize(): Promise<void> {
    // Check if file exists, create it with header if not
    const file = Bun.file(this.filePath);
    const exists = await file.exists();
    if (!exists) {
      // Create file with CSV header
      const header = "e,a,v,tx,op\n";
      await Bun.write(this.filePath, header);
    }

    const datoms = await this._loadDatoms();
    // Create a new memory database instance with loaded datoms
    // Note: Hooks should be registered after initialize() (recommended pattern)
    // InMemoryDatomDatabase constructor will automatically calculate nextTx from datoms
    this._memoryDb = new InMemoryDatomDatabase(datoms);
    await this._memoryDb.initialize();
  }

  /**
   * Close the database and persist final state
   */
  async close(): Promise<void> {
    // Persist before closing
    await this._persist();
    await this._memoryDb.close();
  }

  /**
   * Register a hook (delegated to memory database)
   */
  hook(hook: Hook): void {
    this._memoryDb.hook(hook);
  }

  /**
   * Execute a transaction and persist to file system
   */
  async transact(
    ops: (DatomInput | DatomInput[])[],
    metadata?: Record<string, unknown>,
    context?: Record<string, unknown>
  ): Promise<TransactionId> {
    // Delegate to memory database
    const txId = await this._memoryDb.transact(ops, metadata, context);

    // Persist to file system after successful transaction
    await this._persist();

    return txId;
  }

  /**
   * Query datoms (delegated to memory database)
   */
  async datoms(options: DatomsQuery): Promise<Datom[]> {
    return this._memoryDb.datoms(options);
  }

  /**
   * Query datoms with metadata (delegated to memory database)
   */
  async datomsWithMetadata(
    options: DatomsQuery
  ): Promise<DatomsResultEnvelope> {
    return this._memoryDb.datomsWithMetadata(options);
  }

  /**
   * Execute a datalog query (delegated to memory database)
   */
  async query(query: DatalogQuery): Promise<QueryResult> {
    return this._memoryDb.query(query);
  }

  /**
   * Execute a datalog query with metadata (delegated to memory database)
   */
  async queryWithMetadata(query: DatalogQuery): Promise<QueryResultEnvelope> {
    return this._memoryDb.queryWithMetadata(query);
  }

  /**
   * Create an as-of view (delegated to memory database)
   */
  asOf(txId: TransactionId): DatabaseView {
    return this._memoryDb.asOf(txId);
  }

  /**
   * Create a history view (delegated to memory database)
   */
  history(): DatabaseView {
    return this._memoryDb.history();
  }

  /**
   * Create a since view (delegated to memory database)
   */
  since(txId: TransactionId): DatabaseView {
    return this._memoryDb.since(txId);
  }

  /**
   * Speculative transaction (delegated to memory database)
   */
  async with(ops: DatomInput[]): Promise<WithResult> {
    return this._memoryDb.with(ops);
  }

  /**
   * Get latest transaction (delegated to memory database)
   */
  async _getLatestTransaction(): Promise<Transaction> {
    return this._memoryDb._getLatestTransaction();
  }

  /**
   * Destroy old datoms (delegated to memory database)
   */
  async _destroy(config: { retentionCount: number }): Promise<number> {
    const result = await this._memoryDb._destroy(config);
    // Persist after destruction
    await this._persist();
    return result;
  }

  /**
   * Load datoms from the file system
   * Returns empty array if file doesn't exist
   */
  private async _loadDatoms(): Promise<Datom[]> {
    try {
      // Check if file exists
      const file = Bun.file(this.filePath);
      const exists = await file.exists();
      if (!exists) {
        return [];
      }

      // Read CSV content
      const content = await file.text();
      const lines = content.split("\n").filter((line) => line.trim() !== "");

      if (lines.length === 0) {
        return [];
      }

      // Skip header row
      const dataLines = lines.slice(1);

      // Parse CSV rows
      const datoms: Datom[] = [];
      for (const line of dataLines) {
        const fields = this._parseCsvLine(line);
        if (fields.length !== 5) {
          continue; // Skip malformed rows
        }

        const [eStr, a, vStr, txStr, op] = fields;
        if (!eStr || !a || vStr === undefined || !txStr || !op) {
          continue; // Skip rows with missing fields
        }

        const e = this._parseEntityId(eStr);
        const v = this._parseValue(vStr);
        const tx = Number.parseInt(txStr, 10);

        if (isNaN(tx) || (op !== "assert" && op !== "retract")) {
          continue; // Skip invalid rows
        }

        datoms.push({
          e,
          a,
          v,
          tx,
          op,
        });
      }

      return datoms;
    } catch (error) {
      // If file doesn't exist or is empty, start fresh
      if (
        error instanceof Error &&
        (error.message.includes("ENOENT") ||
          error.message.includes("Unexpected end"))
      ) {
        return [];
      }

      // For parse errors, throw to prevent corrupted data
      throw new Error(
        `Failed to load datoms from ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Parse a CSV line handling quoted fields
   */
  private _parseCsvLine(line: string): string[] {
    const fields: string[] = [];
    let currentField = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          // Escaped quote
          currentField += '"';
          i++; // Skip next quote
        } else {
          // Toggle quote state
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        // Field separator
        fields.push(currentField);
        currentField = "";
      } else {
        currentField += char;
      }
    }

    // Add last field
    fields.push(currentField);
    return fields;
  }

  /**
   * Parse entity ID from string (supports number and string)
   */
  private _parseEntityId(str: string): EntityId {
    const num = Number.parseFloat(str);
    if (!isNaN(num) && Number.isFinite(num) && str.trim() === String(num)) {
      return num;
    }
    return str;
  }

  /**
   * Parse value from string, handling JSON-encoded values
   */
  private _parseValue(str: string): Value {
    if (str === "") {
      return undefined;
    }

    // Try to parse as JSON first (for complex values)
    try {
      const parsed: unknown = JSON.parse(str);
      // Validate it's a valid Value type
      if (
        typeof parsed === "string" ||
        typeof parsed === "number" ||
        typeof parsed === "boolean" ||
        parsed === null ||
        parsed === undefined
      ) {
        return parsed as Value;
      }
    } catch {
      // Not JSON, continue with string parsing
    }

    // Try to parse as number
    const num = Number.parseFloat(str);
    if (!isNaN(num) && Number.isFinite(num) && str.trim() === String(num)) {
      return num;
    }

    // Try to parse as boolean
    if (str === "true") return true;
    if (str === "false") return false;

    // Return as string
    return str;
  }

  /**
   * Persist all datoms to the file system
   * Uses CSV format matching server.ts: header "e,a,v,tx,op" followed by data rows
   */
  private async _persist(): Promise<void> {
    try {
      // Get all datoms from the memory database using public API
      // Use a large limit similar to server.ts
      const allDatoms = await this._memoryDb.datoms({
        limit: 1_000_000,
      });

      // Sort by entity ID (as shown in server.ts)
      allDatoms.sort((a, b) => {
        const aE = String(a.e);
        const bE = String(b.e);
        return aE > bE ? 1 : aE < bE ? -1 : 0;
      });

      // CSV header
      const header = "e,a,v,tx,op";

      // Convert datoms to CSV rows, escaping quotes and commas properly
      const rows = allDatoms.map((datom) => {
        return [
          this._csvEscape(datom.e),
          this._csvEscape(datom.a),
          this._csvEscape(datom.v),
          this._csvEscape(datom.tx),
          this._csvEscape(datom.op),
        ].join(",");
      });

      const csvContent = [header, ...rows].join("\n") + "\n";
      await Bun.write(this.filePath, csvContent);
    } catch (error) {
      // Log error but don't throw to avoid breaking transactions
      console.error(
        `Failed to persist datoms to ${this.filePath}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Escape a value for CSV format
   * Escapes double quotes by doubling them and wraps fields containing quotes/commas/newlines
   */
  private _csvEscape(val: unknown): string {
    if (val === null || val === undefined) {
      return "";
    }

    // For complex values, stringify as JSON
    if (
      typeof val === "object" ||
      typeof val === "boolean" ||
      (typeof val === "number" && !Number.isFinite(val))
    ) {
      val = JSON.stringify(val);
    }

    let str = String(val);

    // Escape double quotes by doubling them and wrap in quotes if needed
    if (/["\n,]/.test(str)) {
      str = '"' + str.replace(/"/g, '""') + '"';
    }

    return str;
  }
}
