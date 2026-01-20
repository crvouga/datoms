import type {Fixture} from '../fixture.js';
import {InMemoryDatomDatabase} from '../../../in-memory/in-memory-datom-database.js';

export const createInMemoryFixture = async (): Promise<Fixture> => {
  const db = new InMemoryDatomDatabase();
  await db.initialize();
  return {
    db,
    beforeEach: async () => {},
    afterEach: async () => {},
  };
};
