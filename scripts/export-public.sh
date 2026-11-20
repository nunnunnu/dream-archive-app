#!/usr/bin/env bash
# 공개 레포(dream-archive-app)로 코드만 내보낸다. GitHub Actions 자동 수집은 공개 레포에서 돈다.
# 넣지 않는 것: 데이터(data/)·원문(.cache/)·평가 결과·더쿠 수집 코드와 설정·내부 문서(PLAN.md, CLAUDE.md)
#   bash scripts/export-public.sh "커밋 메시지"
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${PUBLIC_REPO_DIR:-$ROOT/../dream-archive-app}"
cd "$ROOT"
mkdir -p "$ROOT/tmp"
git -c core.quotePath=false ls-files | grep -vE '^(data/|\.cache/|eval/results/|tmp/|PLAN\.md$|CLAUDE\.md$|collector/lib/theqoo(\.test)?\.ts$)|(^|/)\.wrangler/' > "$ROOT/tmp/public-files.txt"
# 비밀값 등록 전 첫 내보내기는 워크플로를 빼고 (SKIP_WORKFLOW=1), push 이벤트로 바로 실행되지 않게
if [ "${SKIP_WORKFLOW:-}" = 1 ]; then grep -v '^\.github/workflows/' "$ROOT/tmp/public-files.txt" > "$ROOT/tmp/pf2.txt" && mv "$ROOT/tmp/pf2.txt" "$ROOT/tmp/public-files.txt"; fi
[ "${DRY_RUN:-}" = 1 ] && { echo "내보낼 파일 목록만 만듦: tmp/public-files.txt"; exit 0; }
[ -d "$OUT/.git" ] || git clone -q https://github.com/nunnunnu/dream-archive-app.git "$OUT"
# 공개 레포의 기존 파일 중 위 목록에 없는 것은 지운다 (.git 제외)
( cd "$OUT" && git ls-files ) | while read -r f; do grep -qxF "$f" "$ROOT/tmp/public-files.txt" || rm -f "$OUT/$f"; done
# 작업 폴더가 아니라 마지막 커밋 내용으로 내보낸다 (커밋 안 한 수정, 특히 다른 도구가 작업 중인 파일이 공개 레포에 섞이지 않게)
SNAP="$ROOT/tmp/export-snapshot"
rm -rf "$SNAP" && mkdir -p "$SNAP"
git -C "$ROOT" archive HEAD | tar -x -C "$SNAP"
git -C "$ROOT" -c core.quotePath=false ls-tree -r --name-only HEAD | grep -xFf "$ROOT/tmp/public-files.txt" > "$ROOT/tmp/public-files-head.txt" || true
rsync -a --files-from="$ROOT/tmp/public-files-head.txt" "$SNAP/" "$OUT/"
# 설정에서 더쿠 항목 빼기
python3 - "$OUT" <<'PY'
import json, sys
p = sys.argv[1] + '/config/group.json'
g = json.load(open(p, encoding='utf-8'))
g.pop('community', None)
json.dump(g, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
PY
cat > "$OUT/.gitignore" <<'GI'
node_modules/
.env
.dev.vars
/data/
/.cache/
/.state-cache/
/tmp/
site/dist/
site/.astro/
.wrangler/
GI
cd "$OUT"
git add -A
if git diff --cached --quiet; then echo "공개 레포: 바뀐 것 없음"; exit 0; fi
git -c user.name="$(git -C "$ROOT" config user.name)" -c user.email="$(git -C "$ROOT" config user.email)" commit -q -m "${1:-코드 갱신}"
git push -q origin HEAD:main
echo "공개 레포에 올림: $(git log --oneline -1)"
