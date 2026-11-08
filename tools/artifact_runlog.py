"""Claude 러닝홈피 아티팩트의 '러닝 로그' 데이터 칸을 data/runs-rows.json 으로 바꾼다.

  python3 tools/artifact_runlog.py <아티팩트 index.html> data/runs-rows.json <갱신 시각 ISO>

<!-- runlog:data:start --> ~ <!-- runlog:data:end --> 사이만 바꾸고 나머지 페이지는 그대로 둔다.
표시가 없으면 아무것도 바꾸지 않고 실패한다.
"""
import json, re, sys

page, rows_path, updated = sys.argv[1], sys.argv[2], sys.argv[3]
rows = json.load(open(rows_path, encoding='utf-8'))
data = {
    "updated": updated,
    "rows": [
        [r["date"], round(float(r["km"]), 2), round(float(r.get("minutes") or 0), 1), r.get("pace"), r.get("hr")]
        for r in sorted(rows, key=lambda r: r["date"]) if r.get("date") and r.get("km")
    ],
}
blob = json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
block = ('<!-- runlog:data:start --><script id="runlog-data" type="application/json">'
         + blob + '</script><!-- runlog:data:end -->')
html = open(page, encoding='utf-8').read()
pat = re.compile(r'<!-- runlog:data:start -->.*?<!-- runlog:data:end -->', re.S)
if len(pat.findall(html)) != 1:
    sys.exit('러닝 로그 데이터 표시를 찾지 못했습니다. 페이지를 바꾸지 않습니다.')
new = pat.sub(lambda m: block, html, count=1)
open(page, 'w', encoding='utf-8').write(new)
print(f"rows {len(data['rows'])} · latest {data['rows'][-1][0]} · changed {new != html}")
