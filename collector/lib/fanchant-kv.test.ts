import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INDEX_KEY, readIndex, readPublicChart, updateIndex, type KvStore } from '../../site/src/lib/fanchant-kv.ts';

function memKV() {
  const m = new Map<string, string>();
  let lists = 0;
  const kv = {
    async get(key: string, opt?: unknown) { const v = m.get(key) ?? null; return v && opt ? JSON.parse(v) : v; },
    async put(key: string, value: string) { m.set(key, value); },
    async delete(key: string) { m.delete(key); },
    async list({ prefix }: { prefix: string }) { lists++; return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
  };
  return { kv: kv as unknown as KvStore, m, lists: () => lists };
}
const chart = (id: string, verified: boolean, title = id) => ({ songId: id, title, durationSec: 100, difficulty: 2, difficultyLabel: '보통', author: '@me', verified, cues: [{ t: 1, text: 'a' }], videos: [{ mode: 'guide', youtubeId: 'AAAAAAAAAAA', offset: 0 }], updatedAt: 'x', updatedBy: 'me@x' });

test('곡 목록 키가 없으면 한 번만 다시 만들고, 공개 곡만 담는다', async () => {
  const { kv, m, lists } = memKV();
  m.set('chart:b', JSON.stringify(chart('b', true, 'B곡')));
  m.set('chart:a', JSON.stringify(chart('a', false)));
  assert.deepEqual((await readIndex(kv)).map((s) => s.songId), ['b']);
  assert.ok(m.has(INDEX_KEY));
  await readIndex(kv);
  assert.equal(lists(), 1);
});

test('저장·삭제 때 그 곡만 목록에서 바꾼다', async () => {
  const { kv, m } = memKV();
  m.set(INDEX_KEY, JSON.stringify({ songs: [], updatedAt: '' }));
  await updateIndex(kv, 'c', chart('c', true) as never);
  await updateIndex(kv, 'd', chart('d', false) as never);
  assert.deepEqual((await readIndex(kv)).map((s) => s.songId), ['c']);
  await updateIndex(kv, 'c', chart('c', false) as never); // 공개 취소
  assert.deepEqual(await readIndex(kv), []);
  await updateIndex(kv, 'c', chart('c', true) as never);
  await updateIndex(kv, 'c', null); // 삭제
  assert.deepEqual(await readIndex(kv), []);
});

test('공개 채보만 읽고, 어드민 저장 정보는 뺀다', async () => {
  const { kv, m } = memKV();
  m.set('chart:e', JSON.stringify(chart('e', true)));
  m.set('chart:f', JSON.stringify(chart('f', false)));
  const e = await readPublicChart(kv, 'e');
  assert.equal(e?.songId, 'e');
  assert.equal(e?.updatedBy, undefined);
  assert.equal(await readPublicChart(kv, 'f'), null);
  assert.equal(await readPublicChart(kv, '../x'), null);
});
