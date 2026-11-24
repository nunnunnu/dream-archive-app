/**
 * 운영자 수정(어드민 "데이터 고치기", KV edits)을 수집 결과에 넣는다.
 * 사이트도 같은 수정을 읽을 때 덧씌우지만, 여기서 넣어야 달력(ics)·물어보기 자료·멤버 페이지·아카이브 요약까지 맞는다.
 * 적용 함수는 사이트와 같은 site/src/lib/edits.ts 를 쓴다.
 */
import type { Edit, EditsDoc } from '../../site/src/lib/edits.ts';

export * from '../../site/src/lib/edits.ts';

/** KV edits 읽기 (설정이 없거나 실패하면 빈 목록: 수집은 계속) */
export async function pullEdits(): Promise<Edit[]> {
  const accountId = process.env.CF_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
  const ns = process.env.CF_KV_REPORTS_ID;
  if (!accountId || !token || !ns) return [];
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${ns}/values/edits`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(String(res.status));
    return ((await res.json()) as EditsDoc).items ?? [];
  } catch (err) {
    console.log(`운영자 수정 목록을 못 읽었어요 (${(err as Error).message}) · 이번 수집은 수정 없이`);
    return [];
  }
}
