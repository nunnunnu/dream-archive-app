/**
 * 드림아카이브 수집 시계: GitHub 자체 예약은 제때 안 돌아서(몇 시간씩 빠짐) Cloudflare 예약 작업이 직접 실행을 요청한다.
 *   매시 정각 → full (기사·유튜브·빈칸 채우기·RAG 색인)
 *   30분 → fast (위버스 공지, 사이트 제보)
 *   3시간마다 50분 → backfill (과거 기사 채우기, 다 채우면 금방 끝남)
 * 비밀값: GH_DISPATCH_TOKEN (dream-archive-app 저장소 Actions: Read and write 만 있는 토큰)
 */
const REPO = 'nunnunnu/dream-archive-app';

export function modeFor(cron, scheduledTime) {
  if (cron === '50 */3 * * *') return 'backfill';
  return new Date(scheduledTime).getUTCMinutes() === 0 ? 'full' : 'fast';
}

export default {
  async scheduled(event, env) {
    const mode = modeFor(event.cron, event.scheduledTime);
    const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/collect.yml/dispatches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'dream-archive-cron',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs: { mode } }),
    });
    // 204면 성공. 실패는 Cloudflare 대시보드 로그에서 본다
    console.log(`dispatch ${mode}: ${res.status}${res.ok ? '' : ` ${(await res.text()).slice(0, 200)}`}`);
  },
};
