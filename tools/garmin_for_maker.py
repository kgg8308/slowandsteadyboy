"""data/latest-runs.json 을 러닝 리뷰 메이커 db('garmin' 컬렉션)에 넣을 문서 파일로 바꾼다.

  python3 -I tools/garmin_for_maker.py data/latest-runs.json <출력 폴더> [며칠 이내, 기본 14]

러닝 하나당 <출력 폴더>/<id>.json 하나. 코스 모양은 db가 중첩 배열을 못 받을 수 있어 평평한 배열(f)로 바꾼다.
handled 같은 메이커 쪽 필드는 넣지 않는다(update 로 합치므로 사용자가 처리한 표시는 지워지지 않는다).
마지막 줄에 문서 id 목록을 최신순으로 출력한다.
"""
import json, os, sys, datetime
UTC = datetime.timezone.utc

src, out = sys.argv[1], sys.argv[2]
days = int(sys.argv[3]) if len(sys.argv) > 3 else 14
runs = json.load(open(src, encoding='utf-8')).get('runs', [])
today = datetime.datetime.now(UTC) + datetime.timedelta(hours=9)
cut = (today - datetime.timedelta(days=days)).strftime('%Y-%m-%d')
os.makedirs(out, exist_ok=True)
ids = []
for r in runs:
    if not r.get('id') or not r.get('date') or r['date'] < cut:
        continue
    doc = {k: v for k, v in r.items() if k != 'route'}
    rt = r.get('route')
    if rt and rt.get('pts'):
        doc['route'] = {'w': rt['w'], 'h': rt['h'], 'f': [c for p in rt['pts'] for c in p]}
    doc['splits'] = [{k: v for k, v in s.items() if v is not None} for s in r.get('splits') or []]
    doc['ingestedAt'] = datetime.datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    json.dump(doc, open(os.path.join(out, r['id'] + '.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    ids.append(r['id'])
print(' '.join(ids))
