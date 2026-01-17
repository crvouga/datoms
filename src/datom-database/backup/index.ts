/**
 * Backup and restore module for DatomDatabase
 * Provides export and import functionality for datoms
 */

export { exportDatoms, importDatoms } from "./backup.js";
export type { Datom, QueryOptions } from "../../types.js";
