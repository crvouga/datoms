import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { AttributeDefinition, SchemaExport } from "../../types.js";
import { Fixture, FIXTURES } from "./fixtures.js";

describe.each(FIXTURES)("Schema Versioning (%s)", (_name, createFixture) => {
  let f: Fixture;

  beforeEach(async () => {
    f = await createFixture();
    await f.beforeEach();
  });

  afterEach(async () => {
    await f.afterEach();
    await f.db.close();
  });

  describe("Export tests", () => {
    test("exportSchema() returns SchemaExport with version metadata", async () => {
      await f.db.defineAttribute({
        name: "name",
        cardinality: "one",
        type: "string",
      });
      await f.db.defineAttribute({
        name: "age",
        cardinality: "one",
        type: "number",
      });

      const exported = await f.db.exportSchema();

      expect(exported).toHaveProperty("version");
      expect(exported).toHaveProperty("schemaVersion");
      expect(exported).toHaveProperty("exportedAt");
      expect(exported).toHaveProperty("attributes");

      expect(typeof exported.version).toBe("number");
      expect(typeof exported.schemaVersion).toBe("number");
      expect(typeof exported.exportedAt).toBe("string");
      expect(Array.isArray(exported.attributes)).toBe(true);
    });

    test("version is set correctly (format version)", async () => {
      const exported = await f.db.exportSchema();
      expect(exported.version).toBe(1); // Current format version
    });

    test("schemaVersion matches getSchemaVersion()", async () => {
      await f.db.migrate(5);
      const exported = await f.db.exportSchema();
      const currentVersion = await f.db.getSchemaVersion();

      expect(exported.schemaVersion).toBe(currentVersion);
      expect(exported.schemaVersion).toBe(5);
    });

    test("exportedAt is valid ISO timestamp", async () => {
      const exported = await f.db.exportSchema();
      const timestamp = new Date(exported.exportedAt);

      expect(timestamp.getTime()).not.toBeNaN();
      expect(exported.exportedAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
      );
    });

    test("attributes array matches current schema", async () => {
      await f.db.defineAttribute({
        name: "email",
        cardinality: "one",
        type: "string",
        unique: true,
      });
      await f.db.defineAttribute({
        name: "tags",
        cardinality: "many",
        type: "string",
      });

      const exported = await f.db.exportSchema();

      expect(exported.attributes).toHaveLength(2);
      expect(exported.attributes.find((a) => a.name === "email")).toBeDefined();
      expect(exported.attributes.find((a) => a.name === "tags")).toBeDefined();

      const emailAttr = exported.attributes.find((a) => a.name === "email")!;
      expect(emailAttr.cardinality).toBe("one");
      expect(emailAttr.type).toBe("string");
      expect(emailAttr.unique).toBe(true);
    });
  });

  describe("Import tests", () => {
    test("import SchemaExport object works correctly", async () => {
      const schemaExport: SchemaExport = {
        version: 1,
        schemaVersion: 2,
        exportedAt: new Date().toISOString(),
        attributes: [
          {
            name: "name",
            cardinality: "one",
            type: "string",
          },
          {
            name: "age",
            cardinality: "one",
            type: "number",
          },
        ],
      };

      await f.db.importSchema(schemaExport);

      const nameDef = f.db.getAttributeDefinition("name");
      const ageDef = f.db.getAttributeDefinition("age");

      expect(nameDef).toBeDefined();
      expect(ageDef).toBeDefined();
      expect(nameDef?.type).toBe("string");
      expect(ageDef?.type).toBe("number");
    });

    test("import legacy AttributeDefinition[] array (backward compatibility)", async () => {
      const legacySchema: AttributeDefinition[] = [
        {
          name: "status",
          cardinality: "one",
          type: "string",
        },
        {
          name: "score",
          cardinality: "one",
          type: "number",
        },
      ];

      await f.db.importSchema(legacySchema);

      const statusDef = f.db.getAttributeDefinition("status");
      const scoreDef = f.db.getAttributeDefinition("score");

      expect(statusDef).toBeDefined();
      expect(scoreDef).toBeDefined();
      expect(statusDef?.type).toBe("string");
      expect(scoreDef?.type).toBe("number");
    });

    test("version validation on import", async () => {
      const invalidSchema: SchemaExport = {
        version: 999, // Unsupported version
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        attributes: [
          {
            name: "test",
            cardinality: "one",
            type: "string",
          },
        ],
      };

      await expect(f.db.importSchema(invalidSchema)).rejects.toThrow(
        "Unsupported schema format version"
      );
    });

    test("schema version is updated after import", async () => {
      const schemaExport: SchemaExport = {
        version: 1,
        schemaVersion: 10,
        exportedAt: new Date().toISOString(),
        attributes: [
          {
            name: "test",
            cardinality: "one",
            type: "string",
          },
        ],
      };

      const versionBefore = await f.db.getSchemaVersion();
      await f.db.importSchema(schemaExport);
      const versionAfter = await f.db.getSchemaVersion();

      expect(versionAfter).toBe(10);
      expect(versionAfter).not.toBe(versionBefore);
    });

    test("import preserves all attribute definitions", async () => {
      const schemaExport: SchemaExport = {
        version: 1,
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        attributes: [
          {
            name: "a",
            cardinality: "one",
            type: "string",
          },
          {
            name: "b",
            cardinality: "many",
            type: "number",
            unique: true,
          },
          {
            name: "c",
            cardinality: "one",
            type: "boolean",
            indexed: true,
          },
        ],
      };

      await f.db.importSchema(schemaExport);

      const aDef = f.db.getAttributeDefinition("a");
      const bDef = f.db.getAttributeDefinition("b");
      const cDef = f.db.getAttributeDefinition("c");

      expect(aDef).toBeDefined();
      expect(bDef).toBeDefined();
      expect(cDef).toBeDefined();

      expect(bDef?.cardinality).toBe("many");
      expect(bDef?.unique).toBe(true);
      expect(cDef?.indexed).toBe(true);
    });
  });

  describe("Version compatibility", () => {
    test("importing same version works", async () => {
      await f.db.migrate(5);
      const currentVersion = await f.db.getSchemaVersion();

      const schemaExport: SchemaExport = {
        version: 1,
        schemaVersion: currentVersion,
        exportedAt: new Date().toISOString(),
        attributes: [],
      };

      // Importing same version should not throw
      await f.db.importSchema(schemaExport);
      const versionAfter = await f.db.getSchemaVersion();
      expect(versionAfter).toBe(currentVersion);
    });

    test("importing newer version updates schema version", async () => {
      await f.db.migrate(3);
      const schemaExport: SchemaExport = {
        version: 1,
        schemaVersion: 7,
        exportedAt: new Date().toISOString(),
        attributes: [
          {
            name: "test",
            cardinality: "one",
            type: "string",
          },
        ],
      };

      await f.db.importSchema(schemaExport);
      const newVersion = await f.db.getSchemaVersion();

      expect(newVersion).toBe(7);
    });
  });

  describe("Round-trip tests", () => {
    test("export then import preserves schema", async () => {
      await f.db.defineAttribute({
        name: "original",
        cardinality: "one",
        type: "string",
        unique: true,
      });

      const exported = await f.db.exportSchema();
      await f.db.importSchema(exported);

      const importedDef = f.db.getAttributeDefinition("original");
      expect(importedDef).toBeDefined();
      expect(importedDef?.cardinality).toBe("one");
      expect(importedDef?.type).toBe("string");
      expect(importedDef?.unique).toBe(true);
    });

    test("multiple export/import cycles maintain consistency", async () => {
      const attributes: AttributeDefinition[] = [
        {
          name: "cycle1",
          cardinality: "one",
          type: "string",
        },
        {
          name: "cycle2",
          cardinality: "many",
          type: "number",
        },
      ];

      await f.db.importSchema(attributes);

      // Multiple cycles
      for (let i = 0; i < 3; i++) {
        const exported = await f.db.exportSchema();
        await f.db.importSchema(exported);
      }

      const cycle1Def = f.db.getAttributeDefinition("cycle1");
      const cycle2Def = f.db.getAttributeDefinition("cycle2");

      expect(cycle1Def).toBeDefined();
      expect(cycle2Def).toBeDefined();
      expect(cycle1Def?.cardinality).toBe("one");
      expect(cycle2Def?.cardinality).toBe("many");
    });
  });
});
