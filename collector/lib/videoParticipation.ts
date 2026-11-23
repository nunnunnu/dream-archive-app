import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mentionedMembers } from './members.ts';
import { ROOT } from './store.ts';

const VERIFIED = JSON.parse(readFileSync(join(ROOT, 'config', 'verified-video-participation.json'), 'utf8')) as {
  excluded: string[];
  members: Record<string, string[]>;
};
export const EXCLUDED_VIDEO_IDS: ReadonlySet<string> = new Set(VERIFIED.excluded);
const CONNECTION_RE = /^\s*NCT\s*2023\s*CONNECTION\s+#([\p{L}\p{N}]+)/iu;
const RELAY_CAM_RE = /^[^\p{L}\p{N}]*([\p{L}]+)\s*:\s*\d.*\bNCT\s*24\s*hr\s*RELAY\s*CAM\b/iu;

function soloVideoMembers(v: { title: string }): string[] | undefined {
  const title = v.title.normalize('NFKC');
  const member = title.match(CONNECTION_RE)?.[1] ?? title.match(RELAY_CAM_RE)?.[1];
  return member ? mentionedMembers(member).members : undefined;
}

/** 합동 영상의 빈 배열은 출연 멤버를 특정하지 못한 것으로, 화면에 멤버 이름을 표시하지 않는다. */
export function verifiedVideoMembers(v: { videoId?: string; title: string }): string[] | undefined {
  return (v.videoId ? VERIFIED.members[v.videoId] : undefined) ?? soloVideoMembers(v);
}

export function isExcludedVideo(v: { videoId: string; title: string }): boolean {
  return EXCLUDED_VIDEO_IDS.has(v.videoId) || soloVideoMembers(v)?.length === 0;
}
