import { KiipFragment, KiipSchema, KiipState, KiipDatabase, SyncData } from './types';
import { Clock } from './Clock';
import { Timestamp } from './Timestamp';
import { MerkleTree } from './MerkleTree';
import { Subscription, SubscribeMethod } from 'suub';
import { nanoid } from 'nanoid';

interface State {
  [table: string]: { [raw: string]: { [column: string]: any } };
}

// latest timestamp for each table-row-column
interface Latest {
  [table: string]: { [raw: string]: { [column: string]: string } };
}

export interface KiipDocumentStore<DB extends KiipSchema, Transaction> {
  prepareSync(): Promise<SyncData>;
  handleSync(data: SyncData): Promise<SyncData>;
  subscribe: SubscribeMethod<KiipState<DB>>;
  getState: () => KiipState<DB>;
  insert<K extends keyof DB>(table: K, doc: DB[K]): Promise<string>;
  update<K extends keyof DB>(table: K, id: string, doc: Partial<DB[K]>): Promise<void>;
}

export async function KiipDocumentStore<Schema extends KiipSchema, Transaction>(
  tx: Transaction,
  documentId: string,
  nodeId: string,
  database: KiipDatabase<Transaction>
): Promise<KiipDocumentStore<Schema, Transaction>> {
  const clock = new Clock(nodeId);
  let state: State = {} as any;
  const latest: Latest = {};
  const sub = Subscription() as Subscription<KiipState<Schema>>;

  // apply all fragments
  await database.onEachFragment(tx, documentId, (fragment) => {
    handleFragments([fragment], 'init');
  });

  return {
    prepareSync,
    handleSync,

    subscribe: sub.subscribe,
    getState,
    insert,
    update,
  };

  function getState(): KiipState<Schema> {
    return state as any;
  }

  async function insert<K extends keyof Schema>(table: K, data: Schema[K]): Promise<string> {
    const rowId = nanoid(16);
    const fragments: Array<KiipFragment> = Object.keys(data).map((column) => ({
      timestamp: clock.send().toString(),
      documentId,
      table: table as string,
      column,
      row: rowId,
      value: data[column],
    }));
    await database.withTransaction(async (tx) => {
      await database.addFragments(tx, fragments);
    });
    handleFragments(fragments, 'update');
    return rowId;
  }

  async function update<K extends keyof Schema>(
    table: K,
    id: string,
    data: Partial<Schema[K]>
  ): Promise<void> {
    const fragments: Array<KiipFragment> = Object.keys(data).map((column) => ({
      timestamp: clock.send().toString(),
      documentId,
      table: table as string,
      column,
      row: id,
      value: data[column],
    }));
    await database.withTransaction(async (tx) => {
      await database.addFragments(tx, fragments);
    });
    await handleFragments(fragments, 'update');
  }

  // return current markle
  async function prepareSync(): Promise<SyncData> {
    return {
      nodeId: clock.node,
      merkle: clock.merkle,
      // we are sending the merkle tree so we don't have fragments to send
      fragments: [],
    };
  }

  // get remote merkle tree and return fragments
  async function handleSync(data: SyncData): Promise<SyncData> {
    return database.withTransaction(async (tx) => {
      await database.addFragments(tx, data.fragments);
      handleFragments(data.fragments, 'update');
      // then compute response
      const diffTime = MerkleTree.diff(clock.merkle, data.merkle);
      if (diffTime === null) {
        return {
          nodeId: clock.node,
          merkle: clock.merkle,
          fragments: [],
        };
      }
      let timestamp = new Timestamp(diffTime, 0, '0');
      const fragments = await database.getFragmentsSince(tx, documentId, timestamp, data.nodeId);
      return {
        nodeId: clock.node,
        merkle: clock.merkle,
        fragments,
      };
    });
  }

  async function handleFragments(fragments: Array<KiipFragment>, mode: 'init' | 'update') {
    const prevState = state;
    fragments.forEach((fragment) => {
      clock.recv(Timestamp.parse(fragment.timestamp));
      applyFragmentOnState(fragment, mode);
    });
    if (state !== prevState && mode === 'update') {
      sub.emit(state as any);
    }
  }

  function applyFragmentOnState(fragment: KiipFragment, mode: 'init' | 'update') {
    const { column, table, row, timestamp, value } = fragment;
    const latestTable = latest[table] || {};
    const latestRow = latestTable[row] || {};
    const latestTs = latestRow[column];
    if (latestTs === undefined || latestTs < timestamp) {
      if (mode === 'update') {
        state = {
          ...state,
        };
        state[table] = { ...(state[table] || {}) };
        state[table][row] = { ...(state[table][row] || {}) };
        state[table][row][column] = value;
      } else {
        state[table] = state[table] || {};
        state[table][row] = state[table][row] || {};
        state[table][row][column] = value;
      }
      // update latest
      latest[table] = latest[table] || {};
      latest[table][row] = latest[table][row] || {};
      latest[table][row][column] = timestamp;
    }
  }
}