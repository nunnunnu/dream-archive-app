/**
 * 드림아카이브 수집 시계: GitHub 자체 예약은 제때 안 돌아서(몇 시간씩 빠짐) Cloudflare 예약 작업이 직접 실행을 요청한다.
 *   매시 정각 → full (기사·유튜브·빈칸 채우기·RAG 색인)
 *   30분 → fast (위버스 공지, 사이트 제보)
 *   15·45분 → 지난번 확인 뒤 새 제보·어드민 결정이 있을 때만 fast (Supabase reports 를 바로 본다)
 *   3시간마다 50분 → backfill (과거 기사 채우기, 다 채우면 금방 끝남)
 *   새벽(한국 시간 2~7시) → 2시간에 한 번 정각 full만 (2·4·6시). 30분 fast·15·45분 제보 실행은 쉬고, 제보 신호는 7시 뒤로 미룬다
 *     (자정 티저 때문에 0~2시는 평소대로. 링크 찾기·backfill은 시각이 정해진 일이라 그대로)
 *   매일 한국 5:30 → batch (일주일 넘은 기사 OpenAI 배치: 어제 결과 반영 + 새로 보내기)
 *   5분마다 → 공개 직후 영상 링크 찾기 시각(app_state 'wake/links', 수집기가 올림)이 됐으면 links
 * 상태는 Supabase(app_state·reports)에 둔다 (예전 Cloudflare KV는 무료 쓰기 한도가 하루 1,000번이라 뗐다)
 * 비밀값: GH_DISPATCH_TOKEN (dream-archive-app 저장소 Actions: Read and write 만 있는 토큰), SUPABASE_SERVICE_ROLE_KEY. 설정값: SUPABASE_URL
 */
const REPO = 'nunnunnu/dream-archive-app';

/** Supabase REST: app_state 읽기·쓰기, 새 제보 확인 */
export function supabaseStore(env) {
  const base = `${(env.SUPABASE_URL ?? '').replace(/\/$/, '')}/rest/v1`;
  const headers = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/json' };
  return {
    async get(key) {
      const res = await fetch(`${base}/app_state?select=value&key=eq.${encodeURIComponent(key)}`, { headers });
      if (!res.ok) throw new Error(`app_state 읽기 실패 ${res.status}`);
      return (await res.json())[0]?.value ?? null;
    },
    async put(key, value) {
      const res = await fetch(`${base}/app_state?on_conflict=key`, {
        method: 'POST', headers: { ...headers, prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{ key, value, updated_at: new Date().toISOString() }]),
      });
      if (!res.ok) throw new Error(`app_state 쓰기 실패 ${res.status}`);
    },
    /** since 뒤에 들어온 제보나 어드민 결정이 있는지 */
    async newReports(since) {
      const t = encodeURIComponent(since);
      const res = await fetch(`${base}/reports?select=id&or=(created_at.gt.${t},decision->>at.gt.${t})&limit=1`, { headers });
      if (!res.ok) throw new Error(`제보 확인 실패 ${res.status}`);
      return (await res.json()).length > 0;
    },
  };
}

const kstHour = (scheduledTime) => (new Date(scheduledTime).getUTCHours() + 9) % 24;
/** 새벽 쉬는 시간: 한국 시간 2시부터 7시 전까지 */
export const isQuiet = (scheduledTime) => { const h = kstHour(scheduledTime); return h >= 2 && h < 7; };

export function modeFor(cron, scheduledTime) {
  if (cron === '50 */3 * * *') return 'backfill';
  const minute = new Date(scheduledTime).getUTCMinutes();
  if (minute % 15 !== 0) return null; // 5·10·20분 등은 링크 찾기만
  if (isQuiet(scheduledTime)) {
    if (kstHour(scheduledTime) === 5 && minute === 30) return 'batch';
    return minute === 0 && kstHour(scheduledTime) % 2 === 0 ? 'full' : null;
  }
  return minute === 0 ? 'full' : 'fast';
}

/** 링크 찾기 시각 중 지난 10분 안에 온 것 (5분마다 보니까 한 번씩만 걸린다) */
export function dueLinkTimes(wake, scheduledTime) {
  const now = new Date(scheduledTime).getTime();
  return (wake?.times ?? []).filter((t) => { const at = Date.parse(t); return at <= now && at > now - 10 * 60_000; });
}

async function dispatch(env, mode) {
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
  return res.ok;
}

export function needsPendingReport(cron, scheduledTime) {
  if (cron === '50 */3 * * *') return false;
  const minute = new Date(scheduledTime).getUTCMinutes();
  return minute === 15 || minute === 45;
}

export default {
  async scheduled(event, env) {
    const store = env.STORE ?? supabaseStore(env);
    // 공개 직후 영상 링크 찾기: 찾을 시각이 됐으면 (보낸 시각은 따로 적어서 두 번 띄우지 않음, 2시간 지난 기록은 지움)
    if (event.cron !== '50 */3 * * *') {
      const wake = await store.get('wake/links').catch(() => null);
      const due = dueLinkTimes(wake, event.scheduledTime);
      if (due.length) {
        const sent = (await store.get('wake/links-sent').catch(() => null)) ?? {};
        const fresh = due.filter((t) => !sent[t]);
        if (fresh.length && (await dispatch(env, 'links'))) {
          const now = new Date(event.scheduledTime).getTime();
          const kept = Object.fromEntries(Object.entries(sent).filter(([t]) => Date.parse(t) > now - 2 * 3600_000));
          for (const t of fresh) kept[t] = new Date(now).toISOString();
          await store.put('wake/links-sent', kept).catch((err) => console.log(`링크 기록 실패: ${err.message}`));
        }
      }
    }
    const mode = modeFor(event.cron, event.scheduledTime);
    if (!mode) return;
    const conditional = needsPendingReport(event.cron, event.scheduledTime);
    if (conditional) {
      // 지난번 확인 시각 뒤에 새 제보·어드민 결정이 있을 때만. 확인 시각은 dispatch 전 시각으로 적어서 그 사이 들어온 것은 다음에 잡힌다
      const checkedAt = new Date(event.scheduledTime).toISOString();
      const last = (await store.get('wake/reports').catch(() => null))?.at ?? new Date(event.scheduledTime - 30 * 60_000).toISOString();
      const fresh = await store.newReports(last).catch((err) => { console.log(`제보 확인 실패: ${err.message}`); return false; });
      if (!fresh) {
        console.log('skip fast: no new report');
        return;
      }
      if (await dispatch(env, mode)) await store.put('wake/reports', { at: checkedAt }).catch(() => {});
      return;
    }
    await dispatch(env, mode);
  },
};
