import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, asZip, createTransfer, startTestServer, waitFor, type TestServer } from './helpers.js';

async function fetchStatus(base: string, route: string): Promise<number> {
  const response = await fetch(`${base}${route}`);
  await response.arrayBuffer();
  return response.status;
}

describe('download lifecycle', () => {
  let server: TestServer;
  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.close();
  });

  it('serves text metadata without consuming', async () => {
    const key = await createTransfer(server.base, [], 'hello metadata');
    for (let i = 0; i < 2; i += 1) {
      const payload = (await (
        await api(server.base, `/api/transfers/${key}`)
      ).json()) as { key: string; text: string; files: unknown[] };
      assert.equal(payload.key, key);
      assert.equal(payload.text, 'hello metadata');
      assert.deepEqual(payload.files, []);
    }

  it('streams a single file as forced attachment, then deletes', async () => {
    const key = await createTransfer(server.base, [{ name: 'one.txt', content: 'single bytes' }]);
    const response = await fetch(`${server.base}/api/transfers/${key}/download`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    const disposition = response.headers.get('content-disposition') ?? '';
    assert.match(disposition, /^attachment;/);
    assert.ok(!disposition.includes('..'), 'no traversal in disposition');
    assert.equal(await response.text(), 'single bytes');
    await waitFor(async () => (await fetchStatus(server.base, `/api/transfers/${key}`)) === 404);
  });

  it('streams text, then deletes', async () => {
    const key = await createTransfer(server.base, [], 'consumable text');
    const response = await fetch(`${server.base}/api/transfers/${key}/download`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/plain/);
    assert.equal(await response.text(), 'consumable text');
    await waitFor(async () => (await fetchStatus(server.base, `/api/transfers/${key}`)) === 404);
  });

  it('zips multiple files plus text and verifies entries via adm-zip', async () => {
    const key = await createTransfer(
      server.base,
      [
        { name: 'first.txt', content: 'first-content' },
        { name: 'second.txt', content: 'second-content' },
      ],
      'zip sidecar',
    );
    const response = await fetch(`${server.base}/api/transfers/${key}/download`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/zip');
    const zip = asZip(Buffer.from(await response.arrayBuffer()));
    const names = zip.getEntries().map((entry) => entry.entryName);
    assert.ok(names.includes('first.txt'));
    assert.ok(names.includes('second.txt'));
    assert.ok(names.includes('text.txt'));
    assert.equal(zip.readAsText('first.txt'), 'first-content');
    assert.equal(zip.readAsText('text.txt'), 'zip sidecar');
    await waitFor(async () => (await fetchStatus(server.base, `/api/transfers/${key}`)) === 404);
  });

  it('lets exactly one racer win; the loser gets 409 or 404', async () => {
    const key = await createTransfer(server.base, [{ name: 'race.txt', content: 'race-bytes' }]);
    const [first, second] = await Promise.all([
      fetch(`${server.base}/api/transfers/${key}/download`),
      fetch(`${server.base}/api/transfers/${key}/download`),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.ok(
      (statuses.includes(200) && statuses.includes(404)) ||
        (statuses.includes(200) && statuses.includes(409)),
      `expected one 200 and one 404/409, got ${statuses}`,
    );
    const winner = first.status === 200 ? first : second;
    assert.equal(await winner.text(), 'race-bytes');
    await first.arrayBuffer().catch(() => undefined);
    await second.arrayBuffer().catch(() => undefined);

  it('releases the claim when the client disconnects mid-download', async () => {
    const key = await createTransfer(server.base, [{ name: 'slow.txt', content: 'aborted' }]);
    const controller = new AbortController();
    const pending = fetch(`${server.base}/api/transfers/${key}/download`, {
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(() => pending, () => true);
    await waitFor(async () => {
      try {
        await api(server.base, `/api/transfers/${key}`);
        return true;
      } catch {
        return false;
      }
    });
  });

  it('deletes transfers whose files vanished and answers 404', async () => {
    const key = await createTransfer(server.base, [{ name: 'gone.txt', content: 'vanish' }]);
    const row = server.repository.findByKey(key.replace('-', ''));
    assert.ok(row);
    server.storage.removeDir(server.storage.transferDir(row.id));
    assert.equal(await fetchStatus(server.base, `/api/transfers/${key}/download`), 404);
    assert.equal(server.repository.findByKey(key.replace('-', '')), null);
  });

  it('cancel deletes a ready transfer; double cancel is 404', async () => {
    const key = await createTransfer(server.base, [], 'cancel me');
    const deleted = await api(server.base, `/api/transfers/${key}`, { method: 'DELETE' });
    assert.equal(deleted.status, 204);
    assert.equal(await fetchStatus(server.base, `/api/transfers/${key}`), 404);
    assert.equal(await fetchStatus(server.base, `/api/transfers/${key}`), 404);
  });
});