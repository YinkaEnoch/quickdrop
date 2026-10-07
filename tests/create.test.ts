import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  api,
  createTransfer,
  listFinalFiles,
  startTestServer,
  type TestServer,
} from './helpers.js';

describe('transfer creation', () => {
  let server: TestServer;
  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.close();
  });

  it('returns a well-formed display key and stores it canonically', async () => {
    const key = await createTransfer(server.base, [], 'round-trip text');
    assert.match(key, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    const row = server.repository.findByKey(key.replace('-', ''));
    assert.ok(row);
    assert.equal(row.textContent, 'round-trip text');
    assert.equal(row.status, 'ready');
    assert.ok(row.expiresAt > row.createdAt);
  });

  it('issues unique keys for identical payloads', async () => {
    const keys = new Set<string>();
    for (let i = 0; i < 10; i += 1) keys.add(await createTransfer(server.base, [], 'same'));
    assert.equal(keys.size, 10);
  });

  it('round-trips text-only metadata without consuming', async () => {
    const key = await createTransfer(server.base, [], 'hello metadata');
    const first = await api(server.base, `/api/transfers/${key}`);
    const payload = (await first.json()) as {
      key: string;
      text: string;
      files: unknown[];
      expiresAt: number;
    };
    assert.equal(payload.key, key);
    assert.equal(payload.text, 'hello metadata');
    assert.deepEqual(payload.files, []);
    assert.ok(payload.expiresAt > Date.now());
    // Reading metadata twice must not consume the transfer.
    const second = await api(server.base, `/api/transfers/${key}`);
    assert.equal(((await second.json()) as { text: string }).text, 'hello metadata');
  });

  it('accepts files+text and lays out NN-file storage', async () => {
    const key = await createTransfer(
      server.base,
      [
        { name: 'a.txt', content: 'aaa', type: 'text/plain' },
        { name: 'b.bin', content: Buffer.from([1, 2, 3, 4]) },
      ],
      'side note',
    );
    const meta = (await (await api(server.base, `/api/transfers/${key}`)).json()) as {
      text: string;
      files: Array<{ name: string; size: number; mimeType: string | null }>;
    };
    assert.equal(meta.text, 'side note');
    assert.equal(meta.files.length, 2);
    assert.equal(meta.files[0]?.name, 'a.txt');
    assert.equal(meta.files[0]?.size, 3);
    assert.equal(meta.files[1]?.name, 'b.bin');

    const row = server.repository.findByKey(key.replace('-', ''));
    assert.ok(row);
    assert.deepEqual(listFinalFiles(server.storage, row.id), ['01-file', '02-file']);
    const records = server.repository.filesByTransferId(row.id);
    assert.deepEqual(
      records.map((record) => [record.storedName, record.originalName]),
      [
        ['01-file', 'a.txt'],
        ['02-file', 'b.bin'],
      ],
    );
  });

  it('text-only transfers leave no directory on disk', async () => {
    const before = new Set(server.storage.listTransferEntries().map((entry) => entry.name));
    await createTransfer(server.base, [], 'no dir please');
    const after = new Set(server.storage.listTransferEntries().map((entry) => entry.name));
    assert.deepEqual([...after].filter((name) => !before.has(name)), []);
  });

  it('rejects empty transfers with 400', async () => {
    await assert.rejects(() => createTransfer(server.base, [], ''), (error: unknown) => {
      assert.equal((error as { status: number }).status, 400);
      return true;
    });
  });
});
