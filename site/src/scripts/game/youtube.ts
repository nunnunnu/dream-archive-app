/**
 * YouTube IFrame Player 래퍼 (응원법 채보 도구·게임 공용)
 *  - 플레이어는 항상 보이는 컨테이너에만 만든다 (크기 0·숨김 금지, 유튜브 약관)
 *  - disablekb: 스페이스가 영상을 멈추지 않게 (게임·녹음 입력으로 쓴다)
 *  - 게임은 controls: 0 으로 재생 바를 숨긴다 (영상·광고·광고 건너뛰기는 그대로 보인다)
 */
export const YTState = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;

export interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(sec: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getPlaybackRate(): number;
  setPlaybackRate(rate: number): void;
  cueVideoById(id: string, startSeconds?: number): void;
  loadVideoById(id: string, startSeconds?: number): void;
  getVideoData?(): { video_id?: string; title?: string };
  destroy(): void;
}
interface YTNamespace {
  Player: new (el: HTMLElement | string, opts: Record<string, unknown>) => YTPlayer;
}
declare global {
  interface Window { YT?: YTNamespace; onYouTubeIframeAPIReady?: () => void }
}

let apiPromise: Promise<YTNamespace> | null = null;
export function loadYouTubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  apiPromise ??= new Promise<YTNamespace>((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT!); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => { apiPromise = null; reject(new Error('유튜브 플레이어를 불러오지 못했어요')); };
    document.head.append(s);
  });
  return apiPromise;
}

/** 재생할 수 없는 영상 오류 코드 → 안내 문구 */
export function ytErrorText(code: number): string {
  if (code === 101 || code === 150) return '이 영상은 유튜브 밖에서 재생할 수 없게 막혀 있어요';
  if (code === 100) return '삭제됐거나 비공개인 영상이에요';
  if (code === 2) return '영상 주소가 올바르지 않아요';
  if (code === 5) return '이 브라우저에서 재생할 수 없는 영상이에요';
  return `영상을 재생할 수 없어요 (오류 ${code})`;
}

/** vars: 게임은 { controls: 0 } (재생 바로 위치를 못 옮기게, 시작·이어서 버튼으로만). 채보 도구는 기본 컨트롤 */
export async function createPlayer(el: HTMLElement, videoId: string, on: { ready?: (p: YTPlayer) => void; state?: (s: number) => void; error?: (code: number) => void; rate?: (r: number) => void } = {}, vars: Record<string, number> = {}): Promise<YTPlayer> {
  const YT = await loadYouTubeApi();
  return new Promise<YTPlayer>((resolve) => {
    const player: YTPlayer = new YT.Player(el, {
      videoId,
      width: '100%',
      height: '100%',
      playerVars: { playsinline: 1, rel: 0, disablekb: 1, origin: location.origin, ...vars },
      events: {
        onReady: () => { on.ready?.(player); resolve(player); },
        onStateChange: (e: { data: number }) => on.state?.(e.data),
        onError: (e: { data: number }) => on.error?.(e.data),
        onPlaybackRateChange: (e: { data: number }) => on.rate?.(e.data),
      },
    });
  });
}
