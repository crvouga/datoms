import type {DatomDatabase} from '../../datom-database.js';

export type Fixture = {
  db: DatomDatabase;
  beforeEach: () => Promise<void>;
  afterEach: () => Promise<void>;
};
