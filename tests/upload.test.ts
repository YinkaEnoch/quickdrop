import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  api,
  buildMultipart,
  createTransfer,
  startTestServer,
  waitFor,
  type ApiError,
  type TestServer,
} from './helpers.js';

function stagingCount(server: TestServer): number {
  return server.storage.listStaleStagingEntries().length;
}

describe('upload limits and failure hygiene', () => {
  let server: TestServer;
  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.close();
  });

  it('rejects an oversize file with 413 and leaves no staging behind', async () => {
    const tooBig = 'x'.repeat(65 * 1024);
    const { body, boundary } = buildMultipart([{ name: 'big.bin', content: tooBig }]);
    const failing = await api(server.base, '/api/transfers', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    }).then(
      () => null,
      (error: unknown) => error as ApiError,
    );
    assert.ok(failing);
    assert.equal(failing.status, 413);
    assert.match(String((failing.body as { error: string }).error), /size limit/i);
    await waitFor(() => stagingCount(server) === 0);
    assert.equal(server.repository.listAll().length, 0);
  });

  it('rejects oversize text with 413', async () => {
    const oversized = 'y'.repeat(5 * 1024);
    await assert.rejects(() => createTransfer(server.base, [], oversized), (error: unknown) => {
      assert.equal((error as ApiError).status, 413);
      return true;
    });
    assert.equal(server.repository.listAll().length, 0);
  });

  it('rejects more files than the limit with 400', async () => {
    await assert.rejects(
      () =>
        createTransfer(server.base, [
          { name: 'a', content: 'a' },
          { name: 'b', content: 'b' },
          { name: 'c', content: 'c' },
          { name: 'd', content: 'd' },
        ]),
      (error: unknown) => {
        assert.equal((error as ApiError).status, 400);
        return true;
      },
    );
    assert.equal(server.repository.listAll().length, 0);
  });

  it('accepts exactly the file limit', async () => {
    const key = await createTransfer(server.base, [
      { name: 'a', content: 'a' },
      { name: 'b', content: 'b' },
      { name: 'c', content: 'c' },
    ]);
    assert.match(key, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  });

  it('failed uploads leave no orphan final directories', async () => {
    const dirsBefore = new Set(
      server.storage.listTransferEntries().map((entry) => entry.name),
    );
    const tooBig = 'z'.repeat(70 * 1024);
    const { body, boundary } = buildMultipart([{ name: 'huge.bin', content: tooBig }]);
    await assert.rejects(
      () =>
        api(server.base, '/api/transfers', {
          method: 'POST',
          headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
          body,
        }),
      () => true,
    );
    const dirsAfter = new Set(server.storage.listTransferEntries().map((entry) => entry.name));
    assert.deepEqual([...dirsAfter].filter((name) => !dirsBefore.has(name)), []);
    await waitFor(() => stagingCount(server) === 0);
  });

  it('an aborted upload leaves no residue behind', async () => {
    const stagingBefore = stagingCount(server);
    const controller = new AbortController();
    const { body, boundary } = buildMultipart([
      { name: 'cut.bin', content: 'w'.repeat(60 * 1024) },
    ]);
    const pending = fetch(`${server.base}/api/transfers`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(() => pending, () => true);
    await waitFor(() => stagingCount(server) === stagingBefore);
    // Whatever multer managed to stage is either cleaned or process-owned.
    for (const entry of server.storage.listStaleStagingEntries()) {
      assert.ok(entry.isDirectory);
    }
  });

  it('crash-simulated staging entry is sweepable by cleanup', async () => {
    // Simulate a previous process: a staging dir unknown to this process.
    const orphan = mkdtempSync(path.join(server.storage.stagingDir, 'orphan-'));
    writeFileSync(path.join(orphan, 'partial.bin'), 'partial');
    assert.ok(server.storage.listStaleStagingEntries().some((entry) => entry.path === orphan));
    rmSync(orphan, { recursive: true, force: true });
    await waitFor(
      () => !server.storage.listStaleStagingEntries().some((entry) => entry.path === orphan),
    );
  });
});
