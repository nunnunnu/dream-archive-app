/**
 * 영상 시계 (FANCHANT_GAME_SPEC.md §3.2·§11)
 *  - getCurrentTime()은 거칠어서 sampleMs마다만 읽고, 그 사이는 performance.now()로 보간한다 (재생 속도 반영)
 *  - PLAYING일 때만 흐른다. 광고·버퍼·일시정지는 모두 정지로 본다
 *  - 샘플 사이 실제 흐른 시간과 0.5초 넘게 어긋나면(시크·광고 끝·버퍼 후 튐) 점프로 기록한다 → jumpedAt
 */
import { YTState } from './youtube';

interface Source { getCurrentTime(): number; getPlayerState(): number; getPlaybackRate?(): number }

export class VideoClock {
  private base = 0;
  private at = 0;
  private rate = 1;
  playing = false;
  state: number = YTState.UNSTARTED;
  /** 마지막 점프를 알아챈 시각 (performance.now). 이 직후 판정을 쉬는 데 쓴다 */
  jumpedAt = 0;
  private timer = 0;

  constructor(private src: Source, private sampleMs = 200, private jumpSec = 0.5) {}

  start() {
    if (this.timer) return;
    this.sample();
    this.timer = window.setInterval(() => this.sample(), this.sampleMs);
  }
  stop() {
    clearInterval(this.timer);
    this.timer = 0;
  }

  /** 상태 변경 콜백·시크 직후에도 부른다 */
  sample(stateHint?: number) {
    let t: number, state: number, rate: number;
    try {
      t = this.src.getCurrentTime() || 0;
      state = stateHint ?? this.src.getPlayerState();
      rate = this.src.getPlaybackRate?.() || 1;
    } catch {
      return;
    }
    const now = performance.now();
    const playing = state === YTState.PLAYING;
    if (this.playing && playing) {
      const predicted = this.base + ((now - this.at) / 1000) * this.rate;
      const diff = t - predicted;
      if (Math.abs(diff) > this.jumpSec) {
        this.jumpedAt = now;
        this.base = t;
      } else {
        // 작은 흔들림은 조금씩만 따라가서 시계가 뒤로 튀지 않게
        this.base = predicted + diff * 0.35;
      }
    } else {
      if (!this.playing && playing && Math.abs(t - this.base) > this.jumpSec) this.jumpedAt = now;
      this.base = t;
    }
    this.at = now;
    this.rate = rate;
    this.playing = playing;
    this.state = state;
  }

  /** 지금 영상 시각(초). 재생 중이 아니면 마지막으로 읽은 값에 멈춰 있다. at=performance.now() 기준 과거 시점도 계산 가능 */
  now(at = performance.now()): number {
    if (!this.playing) return this.base;
    return this.base + ((at - this.at) / 1000) * this.rate;
  }

  /** 시크했을 때: 바로 그 값으로 맞춘다 */
  jumpTo(sec: number) {
    this.base = sec;
    this.at = performance.now();
    this.jumpedAt = this.at;
  }
}
