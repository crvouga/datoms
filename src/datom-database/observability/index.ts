/**
 * Observability module for DatomDatabase
 * Provides event system, statistics, health checks, and metrics tracking
 */

export { ObservableDatabase } from "./observable-database.js";
export type {
  DatabaseEvent,
  DatabaseEventListener,
  DatabaseHealth,
  DatabaseStats,
} from "../../types.js";
