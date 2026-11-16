// 가민 커넥트에서 러닝 기록을 받아 index.html 의 '러닝 로그' 자리를 채우고,
// 대시보드 등에서 쓸 수 있게 data/runs.json 도 만든다.
//
//   GARMIN_PERSONAL_API_KEY=xxxx node runs.mjs
//
// 흐름: 가민 시계 → 가민 커넥트 → (가민 개인 API) → 이 스크립트
//
// - 가민 개인 API 키는 connect.garmin.com/app/settings/personalApiToken 에서 무료로 만든다.
//   깃허브 저장소 Settings → Secrets 의 GARMIN_PERSONAL_API_KEY 에 넣는다. 코드에 쓰지 않는다.
//   키는 최대 1년짜리라, 만료 전에 가민이 메일을 보내면 새로 만들어 시크릿만 바꿔 넣으면 된다.
// - 예비 경로로 intervals.icu API 키(INTERVALS_API_KEY)도 받는다. 가민 키가 있으면 가민을 쓴다.
// - 키가 없으면 아무것도 바꾸지 않고 조용히 끝난다. 영상 갱신은 그대로 돈다.
// - data/history.json 은 스트라바 아카이브(애플워치 기록 포함)에서 한 번 뽑아 둔 과거 기록이다.
//   가민 기록과 합친 뒤, 두 시계로 같이 뛴 러닝은 하나로 합친다.
// - 1km 미만(워밍업 등)은 뺀다.
// - GPS 경로·출발 시각은 공개하지 않는다. 날짜·거리·시간·페이스·심박만 쓴다.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  garminKey: process.env.GARMIN_PERSONAL_API_KEY || '',
  garminBase: 'https://personal.connectapi.garmin.com',
  apiKey: process.env.INTERVALS_API_KEY || '',
  athleteId: process.env.INTERVALS_ATHLETE_ID || '0',
  since: '2023-01-01', // 이 날짜 이후 기록만 받는다
  recent: 6, // 최근 러닝 몇 개를 보여줄지
  months: 12, // 월별 막대 몇 달치
  types: ['Run', 'VirtualRun', 'TrailRun'],
  minDistance: 1000, // m — 이보다 짧은 기록은 뺀다
  fixture: process.env.RUNS_FIXTURE || '', // 테스트용: API 대신 이 JSON 파일을 읽는다
};

const START = '<!-- runs:start -->';
const END = '<!-- runs:end -->';

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// 한국 시간 기준 '오늘'. 액션은 UTC 로 돈다.
const todayKST = () => {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()).split('-');
  return { y: +y, m: +m, d: +d };
};

const fmtKm = (m) => (m / 1000).toFixed(m >= 100000 ? 0 : 1);
const fmtDur = (s) => {
  s = Math.round(s);
  const h = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
};
const fmtPace = (sec, meters) => {
  if (!meters) return '-';
  const p = Math.round(sec / (meters / 1000));
  return `${Math.floor(p / 60)}'${String(p % 60).padStart(2, '0')}"`;
};

const todayStr = () => {
  const { y, m, d } = todayKST();
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

// ── 가민 개인 API ──────────────────────────────────────────────
// 키 → 24시간짜리 토큰 → 활동 검색(100개씩 넘겨 가며). 가민 공식 예제와 같은 경로를 쓴다.
async function garminToken() {
  const res = await fetch(`${CONFIG.garminBase}/personalapitoken-service/personal-api/personal-api-key/token`, {
    method: 'POST',
    headers: { Accept: '*/*', Authorization: `ApiKey ${CONFIG.garminKey}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`가민 토큰 발급 실패 HTTP ${res.status} (키가 틀렸거나 만료됐을 수 있습니다)`);
  return (await res.text()).trim();
}

// 가민 검색은 한 번에 넓은 기간을 주면 앞쪽 일부만 돌려준다(2026-11 확인: 6월 초에서 끊김).
// 그래서 날짜 없이 최신순 한 번 + 60일 단위 구간으로 나눠 받아 activityId 로 합친다.
async function garminPages(token, extra) {
  const out = [];
  for (let start = 0; start < 2000; start += 100) {
    const qs = new URLSearchParams({ start, limit: 100, ...extra });
    const res = await fetch(`${CONFIG.garminBase}/activitylist-service/activities/search/activities?${qs}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`가민 활동 조회 실패 HTTP ${res.status}`);
    const page = (await res.json()) ?? [];
    const list = Array.isArray(page) ? page : page.activityList ?? page.activities ?? [];
    out.push(...list);
    if (list.length < 100) break;
  }
  return out;
}

const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

const GARMIN = { token: '', raw: [] }; // 상세 리포트(latest-runs.json)용

async function fetchGarmin() {
  const token = await garminToken();
  GARMIN.token = token;
  const byId = new Map();
  const keep = (list) => list.forEach((a) => a?.activityId != null && byId.set(String(a.activityId), a));
  const newestOf = (list) => list.map((a) => String(a.startTimeLocal ?? '')).sort().pop() || '없음';

  const latest = await garminPages(token, {});
  keep(latest);
  console.log(`가민 최신순 조회: ${latest.length}개, 가장 최근 ${newestOf(latest)}`);

  const end = addDays(todayStr(), 1);
  for (let from = CONFIG.since; from <= end; from = addDays(from, 60)) {
    const to = addDays(from, 59) < end ? addDays(from, 59) : end;
    const part = await garminPages(token, { startDate: from, endDate: to });
    keep(part);
    if (part.length) console.log(`  ${from}~${to}: ${part.length}개`);
  }
  const all = [...byId.values()];
  console.log(`가민 활동 ${all.length}개, 가장 최근: ${newestOf(all)}`);
  GARMIN.raw = all;
  return all;
}

// 가민 '2026-11-01 07:02:11' 형식. GMT 쪽은 Z 를 붙여 UTC 로 읽는다.
const gmt = (t) => (t ? Date.parse(String(t).replace(' ', 'T') + (/[zZ+]/.test(t) ? '' : 'Z')) : NaN);

function normalizeGarmin(list) {
  return list
    .filter((a) => /running/.test(a.activityType?.typeKey ?? a.activityTypeDTO?.typeKey ?? '') && a.distance > 0)
    .map((a) => {
      const local = String(a.startTimeLocal ?? '');
      return {
        id: String(a.activityId),
        date: local.slice(0, 10),
        start: gmt(a.startTimeGMT) || Date.parse(local.replace(' ', 'T')),
        type: a.activityType?.typeKey ?? 'running',
        distance: Math.round(a.distance),
        moving: Math.round(a.movingDuration || a.duration || 0),
        hr: a.averageHR ? Math.round(a.averageHR) : null,
        elev: a.elevationGain ? Math.round(a.elevationGain) : null,
        source: 'garmin',
      };
    })
    .filter((r) => r.date && r.moving > 0);
}

// ── intervals.icu (예비) ───────────────────────────────────────
async function fetchIntervals() {
  const url = `https://intervals.icu/api/v1/athlete/${encodeURIComponent(CONFIG.athleteId)}/activities?oldest=${CONFIG.since}&newest=${todayStr()}`;
  const auth = Buffer.from(`API_KEY:${CONFIG.apiKey}`).toString('base64');
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function normalizeIntervals(list) {
  return list
    .filter((a) => CONFIG.types.includes(a.type) && a.distance > 0 && a.moving_time > 0)
    .map((a) => ({
      id: String(a.id),
      date: String(a.start_date_local || a.start_date || '').slice(0, 10),
      start: Date.parse(a.start_date || a.start_date_local),
      type: a.type,
      distance: Math.round(a.distance), // m
      moving: Math.round(a.moving_time), // 초
      hr: a.average_heartrate ? Math.round(a.average_heartrate) : null,
      elev: a.total_elevation_gain ? Math.round(a.total_elevation_gain) : null,
      source: a.device_name || a.source || '',
    }))
    .filter((r) => r.date);
}

function loadHistory() {
  try {
    const { runs } = JSON.parse(readFileSync(join(HERE, 'data', 'history.json'), 'utf8'));
    return Array.isArray(runs) ? runs : [];
  } catch {
    return [];
  }
}

async function fetchRuns() {
  const history = loadHistory();
  const live = await fetchLive();
  if (history.length) console.log(`과거 기록 ${history.length}개를 합칩니다.`);
  return [...live, ...history].filter((r) => r.distance >= CONFIG.minDistance);
}

async function fetchLive() {
  if (CONFIG.fixture) {
    const raw = JSON.parse(readFileSync(CONFIG.fixture, 'utf8'));
    return raw[0]?.activityId ? normalizeGarmin(raw) : normalizeIntervals(raw);
  }
  if (CONFIG.garminKey) return normalizeGarmin(await fetchGarmin());
  return normalizeIntervals(await fetchIntervals());
}

// 가민·애플워치를 동시에 차고 뛰면 같은 러닝이 두 번 들어온다.
// 출발 시각이 15분 이내이고 거리가 15% 이내로 같으면 하나로 본다.
// 심박이 있는 쪽, 그다음 거리가 긴 쪽을 남긴다.
function dedupe(runs) {
  const sorted = [...runs].sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of sorted) {
    const twin = out.find(
      (o) => Math.abs(o.start - r.start) <= 15 * 60 * 1000 &&
        Math.abs(o.distance - r.distance) <= 0.15 * Math.max(o.distance, r.distance),
    );
    if (!twin) { out.push(r); continue; }
    const better = (!!r.hr - !!twin.hr) || (r.distance - twin.distance);
    if (better > 0) out[out.indexOf(twin)] = r;
  }
  return out.sort((a, b) => b.start - a.start);
}

function summarize(runs) {
  const { y, m } = todayKST();
  const mm = `${y}-${String(m).padStart(2, '0')}`;
  const sum = (arr) => arr.reduce((s, r) => s + r.distance, 0);
  const thisMonth = runs.filter((r) => r.date.startsWith(mm));
  const thisYear = runs.filter((r) => r.date.startsWith(String(y)));
  const longest = runs.reduce((a, r) => (!a || r.distance > a.distance ? r : a), null);

  const monthly = [];
  for (let i = CONFIG.months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const key = d.toISOString().slice(0, 7);
    const list = runs.filter((r) => r.date.startsWith(key));
    monthly.push({ month: key, km: +(sum(list) / 1000).toFixed(1), runs: list.length });
  }

  // 주간: 월요일 시작, 한국 시간. 지난주 월요일 ~ 이번 주 일요일 14일.
  const { d } = todayKST();
  const today = new Date(Date.UTC(y, m - 1, d));
  const dow = (today.getUTCDay() + 6) % 7; // 월=0 … 일=6
  const lastMon = new Date(today.getTime() - (dow + 7) * 864e5);
  const iso = (t) => t.toISOString().slice(0, 10);
  const todayIso = iso(today);
  const days = [];
  for (let i = 0; i < 14; i++) {
    const date = iso(new Date(lastMon.getTime() + i * 864e5));
    const list = runs.filter((r) => r.date === date);
    days.push({ date, km: +(sum(list) / 1000).toFixed(1), runs: list.length, today: date === todayIso, future: date > todayIso });
  }
  const week = (arr) => ({ from: arr[0].date, to: arr[6].date, km: +arr.reduce((a, x) => a + x.km, 0).toFixed(1), runs: arr.reduce((a, x) => a + x.runs, 0) });

  return {
    updated: new Date().toISOString(),
    lastWeek: week(days.slice(0, 7)),
    thisWeek: week(days.slice(7)),
    days,
    twoWeeks: runs.filter((r) => r.date >= days[0].date && r.date <= todayIso),
    month: { key: mm, km: +(sum(thisMonth) / 1000).toFixed(1), runs: thisMonth.length },
    year: { key: String(y), km: +(sum(thisYear) / 1000).toFixed(1), runs: thisYear.length },
    longest: longest && { date: longest.date, km: +(longest.distance / 1000).toFixed(2) },
    monthly,
    recent: runs.slice(0, CONFIG.recent),
  };
}

function render(s) {
  const max = Math.max(1, ...s.monthly.map((x) => x.km));
  const bars = s.monthly.map((x) => {
    const h = Math.round((x.km / max) * 100);
    const cur = x.month === s.month.key ? ' cur' : '';
    return `      <div class="log-bar${cur}" title="${esc(x.month)} · ${x.km}km · ${x.runs}회"><span style="height:${h}%"></span><em>${+x.month.slice(5)}</em></div>`;
  }).join('\n');

  const runRow = (r) => `
    <div class="log-run">
      <time>${esc(r.date.replaceAll('-', '.'))} <small>${'일월화수목금토'[new Date(r.date + 'T00:00:00Z').getUTCDay()]}</small></time>
      <b class="num">${fmtKm(r.distance)}<small>km</small></b>
      <span><i>시간</i>${fmtDur(r.moving)}</span>
      <span><i>페이스</i>${fmtPace(r.moving, r.distance)}</span>
      <span><i>심박</i>${r.hr ?? '-'}</span>
    </div>`;
  const rows = s.twoWeeks.length
    ? s.twoWeeks.map(runRow).join('')
    : '\n    <p class="log-none">최근 2주 동안 기록된 러닝이 없습니다.</p>';

  const md = (iso) => `${+iso.slice(5, 7)}.${+iso.slice(8)}`;
  const diff = +(s.thisWeek.km - s.lastWeek.km).toFixed(1);
  const nudge = diff >= 0
    ? `지난주보다 <b>${diff}km</b> 더 달렸어요`
    : `지난주 기록까지 <b>${-diff}km</b> 남았어요`;
  const dmax = Math.max(1, ...s.days.map((x) => x.km));
  const dayCell = (x, i) => {
    const cls = ['log-day', x.km ? 'on' : '', x.today ? 'today' : '', x.future ? 'future' : ''].filter(Boolean).join(' ');
    return `<div class="${cls}" title="${esc(md(x.date))} · ${x.km}km"><i>${'월화수목금토일'[i % 7]}</i><span><span style="height:${Math.round((x.km / dmax) * 100)}%"></span></span><em>${x.km ? x.km : ''}</em></div>`;
  };
  const weekRow = (label, arr) => `
      <div class="log-wrow"><strong>${label}</strong>${arr.map(dayCell).join('')}</div>`;

  const upd = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(s.updated));

  return `
  <div class="log-week">
    <div class="log-wk now"><span>이번 주 · ${md(s.thisWeek.from)}–${md(s.thisWeek.to)}</span><b class="num">${s.thisWeek.km}<small>km</small></b><em>${s.thisWeek.runs}회</em></div>
    <div class="log-wk"><span>지난주 · ${md(s.lastWeek.from)}–${md(s.lastWeek.to)}</span><b class="num">${s.lastWeek.km}<small>km</small></b><em>${s.lastWeek.runs}회</em></div>
    <p class="log-nudge">${nudge}</p>
    <div class="log-days" aria-label="최근 2주 날짜별 거리">${weekRow('지난주', s.days.slice(0, 7))}${weekRow('이번 주', s.days.slice(7))}
    </div>
  </div>
  <h3 class="log-sub">최근 2주 러닝</h3>
  <div class="log-runs">${rows}
  </div>
  <h3 class="log-sub">누적 기록</h3>
  <div class="log-stats">
    <div><span>이번 달</span><b class="num">${s.month.km}<small>km</small></b><em>${s.month.runs}회</em></div>
    <div><span>${esc(s.year.key)}년 누적</span><b class="num">${s.year.km}<small>km</small></b><em>${s.year.runs}회</em></div>
    <div><span>최장 거리</span><b class="num">${s.longest ? s.longest.km : '-'}<small>km</small></b><em>${s.longest ? esc(s.longest.date.replaceAll('-', '.')) : ''}</em></div>
  </div>
  <div class="log-chart" aria-label="최근 ${s.monthly.length}개월 월별 거리">
${bars}
  </div>
  <p class="log-upd">가민 기록 자동 반영 · ${esc(upd)} 갱신</p>
  `;
}

// 날짜·거리(km)·시간(분)·페이스(초/km)·심박·상승고도
function toRows(runs) {
  return runs.map((r) => ({
    id: String(r.id),
    date: r.date,
    km: Math.round(r.distance / 10) / 100,
    minutes: Math.round(r.moving / 6) / 10,
    pace: Math.round(r.moving / (r.distance / 1000)),
    hr: r.hr ?? null,
    elev: r.elev ?? null,
  }));
}


// ── 리뷰 메이커용 상세 리포트 ─────────────────────────────────────
// 최근 가민 러닝 몇 개만 골라 심박·VO2max·케이던스·km 스플릿·코스 모양·날씨까지 담아
// data/latest-runs.json 에 쓴다. 러닝 리뷰 메이커가 이 파일로 '가민 리포트' 한 장을 만든다.
// 공개 원칙: 위도·경도·출발 시각은 쓰지 않는다. 코스는 앞뒤 300m 를 잘라낸 '모양'만 0~1 좌표로 남긴다.
const LATEST_N = 5;
const PRIVACY_TRIM_M = 300;

// 자주 달리는 코스 이름 맞추기 (러닝홈피·리뷰 메이커의 코스 목록과 같은 이름)
const PLACES = {
  dongbaek: [35.1530, 129.1525],
  gwangalli: [35.1532, 129.1186],
  cheongsapo: [35.1606, 129.1918],
};

const toRad = (d) => (d * Math.PI) / 180;
function meters(a, b) {
  const R = 6371000;
  const dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function guessCourse(pts) {
  if (!pts.length) return '';
  const near = (p, m) => pts.some((q) => meters(q, p) < m);
  const maxLon = Math.max(...pts.map((p) => p[1]));
  const minLon = Math.min(...pts.map((p) => p[1]));
  if (!near(PLACES.dongbaek, 700)) return '';
  if (maxLon > 129.185 && near(PLACES.cheongsapo, 900)) return '동백섬 → 청사포 등대';
  if (pts.some((p) => p[0] > 35.165 && p[1] < 129.14)) return '동백섬 ↔ 수영강 휴먼브릿지';
  if (minLon < 129.125 && near(PLACES.gwangalli, 900)) return '동백섬 ↔ 광안리';
  return '동백섬 BRC 코스';
}

// 앞뒤를 잘라내고 모양만 남긴다 (0~1, 가로세로 비율 유지)
function routeShape(pts) {
  if (pts.length < 10) return null;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + meters(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1];
  if (total < PRIVACY_TRIM_M * 3) return null;
  const mid = pts.filter((_, i) => cum[i] >= PRIVACY_TRIM_M && cum[i] <= total - PRIVACY_TRIM_M);
  if (mid.length < 8) return null;
  const lat0 = mid.reduce((a, p) => a + p[0], 0) / mid.length;
  const xy = mid.map((p) => [p[1] * Math.cos(toRad(lat0)), -p[0]]);
  const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const span = Math.max(Math.max(...xs) - x0, Math.max(...ys) - y0) || 1;
  const step = Math.max(1, Math.ceil(xy.length / 160));
  const out = xy.filter((_, i) => i % step === 0 || i === xy.length - 1)
    .map((p) => [+((p[0] - x0) / span).toFixed(3), +((p[1] - y0) / span).toFixed(3)]);
  return { w: +((Math.max(...xs) - x0) / span).toFixed(3), h: +((Math.max(...ys) - y0) / span).toFixed(3), pts: out };
}

async function garminGet(path) {
  const res = await fetch(`${CONFIG.garminBase}${path}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${GARMIN.token}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

const num = (v, d = 0) => (v == null || Number.isNaN(+v) ? null : +(+v).toFixed(d));
const daypart = (h) => (h < 5 ? '새벽' : h < 11 ? '아침' : h < 14 ? '점심' : h < 18 ? '오후' : h < 22 ? '저녁' : '밤');

let fieldsLogged = false;
async function detailOf(a) {
  const id = String(a.activityId);
  if (!fieldsLogged) { fieldsLogged = true; console.log('  가민 활동 항목: ' + Object.keys(a).sort().join(',')); }
  const local = String(a.startTimeLocal ?? '');
  const dist = a.distance || 0;
  const moving = a.movingDuration || a.duration || 0;
  const r = {
    id,
    date: local.slice(0, 10),
    daypart: daypart(+local.slice(11, 13) || 0),
    name: a.activityName || '',
    location: a.locationName || '',
    km: +(dist / 1000).toFixed(2),
    moving: Math.round(moving),
    elapsed: Math.round(a.elapsedDuration || a.duration || moving),
    pace: dist ? Math.round(moving / (dist / 1000)) : null,
    bestPace: a.maxSpeed ? Math.round(1000 / a.maxSpeed) : null,
    hr: num(a.averageHR), hrMax: num(a.maxHR),
    cadence: num(a.averageRunningCadenceInStepsPerMinute), cadenceMax: num(a.maxRunningCadenceInStepsPerMinute),
    stride: a.avgStrideLength ? num(a.avgStrideLength) : null, // cm
    elev: num(a.elevationGain), elevLoss: num(a.elevationLoss),
    calories: num(a.calories),
    vo2max: num(a.vO2MaxValue),
    teAerobic: num(a.aerobicTrainingEffect, 1), teAnaerobic: num(a.anaerobicTrainingEffect, 1),
    teLabel: a.trainingEffectLabel || '',
    load: num(a.activityTrainingLoad),
    power: num(a.avgPower),
    steps: num(a.steps),
    splits: [], course: '', route: null, weather: null,
  };
  const notes = [];
  try {
    const sp = await garminGet(`/activity-service/activity/${id}/splits`);
    const laps = sp?.lapDTOs ?? [];
    r.splits = laps.filter((l) => l.distance > 50).map((l) => ({
      km: +(l.distance / 1000).toFixed(2),
      pace: l.distance ? Math.round((l.movingDuration || l.duration) / (l.distance / 1000)) : null,
      hr: num(l.averageHR),
      elev: num(l.elevationGain),
    }));
  } catch (e) { notes.push(`splits ${e.message}`); }
  try {
    const d = await garminGet(`/activity-service/activity/${id}/details?maxChartSize=10&maxPolylineSize=600`);
    const pts = (d?.geoPolylineDTO?.polyline ?? []).map((p) => [p.lat, p.lon]).filter((p) => p[0] && p[1]);
    r.course = guessCourse(pts);
    r.route = routeShape(pts);
  } catch (e) { notes.push(`route ${e.message}`); }
  try {
    const w = await garminGet(`/weather-service/weather/${id}`);
    if (w && w.temp != null) {
      r.weather = {
        c: Math.round(((w.temp - 32) * 5) / 9), // 가민 날씨는 화씨
        desc: w.weatherTypeDTO?.desc || '',
        humidity: num(w.relativeHumidity),
        wind: w.windSpeed != null ? num(w.windSpeed * 0.44704, 1) : null, // mph → m/s
      };
    }
  } catch (e) { notes.push(`weather ${e.message}`); }
  if (r.vo2max == null && r.date) {
    try {
      const m = await garminGet(`/metrics-service/metrics/maxmet/daily/${r.date}/${r.date}`);
      const g = (Array.isArray(m) ? m : [m]).map((x) => x?.generic).find(Boolean);
      r.vo2max = num(g?.vo2MaxPreciseValue ?? g?.vo2MaxValue, g?.vo2MaxPreciseValue ? 1 : 0);
    } catch (e) { notes.push(`vo2max ${e.message}`); }
  }
  console.log(`  상세 ${r.date} ${r.km}km: 스플릿 ${r.splits.length}개, 코스 ${r.course || (r.route ? '모양만' : '없음')}, VO2max ${r.vo2max ?? '-'}, 날씨 ${r.weather ? r.weather.c + '°C' : '-'}${notes.length ? ' · 못 받음: ' + notes.join(', ') : ''}`);
  return r;
}

async function writeLatest() {
  if (!GARMIN.token || !GARMIN.raw.length) return;
  const path = join(HERE, 'data', 'latest-runs.json');
  let prev = { runs: [] };
  try { prev = JSON.parse(readFileSync(path, 'utf8')); } catch {}
  const known = new Map((prev.runs || []).map((r) => [r.id, r]));
  const recent = GARMIN.raw
    .filter((a) => /running/.test(a.activityType?.typeKey ?? '') && a.distance >= CONFIG.minDistance)
    .sort((a, b) => String(b.startTimeLocal).localeCompare(String(a.startTimeLocal)))
    .slice(0, LATEST_N);
  const runs = [];
  for (const a of recent) {
    const id = String(a.activityId);
    const old = known.get(id);
    // 이미 상세를 받은 러닝은 다시 묻지 않는다 (코스·스플릿 둘 다 있을 때)
    if (old && old.splits?.length && (old.route || old.course)) { runs.push(old); continue; }
    try { runs.push(await detailOf(a)); } catch (e) { console.error(`상세 실패 ${id}: ${e.message}`); if (old) runs.push(old); }
  }
  if (!runs.length) return;
  const next = JSON.stringify({ runs }, null, 1);
  const before = JSON.stringify({ runs: prev.runs || [] }, null, 1);
  if (next === before) { console.log('상세 리포트에 바뀐 게 없습니다.'); return; }
  mkdirSync(join(HERE, 'data'), { recursive: true });
  writeFileSync(path, JSON.stringify({ updated: new Date().toISOString(), runs }, null, 1) + '\n');
  console.log(`data/latest-runs.json 갱신: 최근 ${runs.length}개 (가장 최근 ${runs[0].date} ${runs[0].km}km)`);
}

async function main() {
  if (!CONFIG.garminKey && !CONFIG.apiKey && !CONFIG.fixture) {
    console.log('GARMIN_PERSONAL_API_KEY 가 없어 러닝 기록 갱신을 건너뜁니다.');
    return;
  }

  let runs;
  try {
    runs = dedupe(await fetchRuns());
    console.log(`러닝 ${runs.length}개를 받았습니다.`);
  } catch (err) {
    console.error(`러닝 기록을 받지 못했습니다: ${err.message}`);
    return; // 기존 화면을 그대로 둔다
  }
  if (!runs.length) {
    console.log('러닝 기록이 없어 기존 내용을 그대로 둡니다.');
    return;
  }

  try { await writeLatest(); } catch (e) { console.error(`상세 리포트를 만들지 못했습니다: ${e.message}`); }

  const summary = summarize(runs);

  const path = join(HERE, 'index.html');
  const html = readFileSync(path, 'utf8');
  const from = html.indexOf(START);
  const to = html.indexOf(END);
  if (from < 0 || to < 0) {
    console.error(`index.html 에서 ${START} / ${END} 표시를 찾지 못했습니다.`);
    process.exit(1);
  }
  const next = html.slice(0, from + START.length) + render(summary) + html.slice(to);

  // 갱신 시각만 바뀐 경우엔 커밋하지 않는다
  const strip = (t) => t.replace(/ · [^<]* 갱신</, '<');
  if (strip(next) === strip(html)) {
    console.log('러닝 기록에 바뀐 게 없습니다.');
    return;
  }
  writeFileSync(path, next);

  mkdirSync(join(HERE, 'data'), { recursive: true });
  const pub = ({ start, source, ...r }) => r; // 공개용: 출발 시각·기기 정보 제외
  const out = { ...summary, recent: summary.recent.map(pub), twoWeeks: summary.twoWeeks.map(pub), runs: runs.map(pub) };
  writeFileSync(join(HERE, 'data', 'runs.json'), JSON.stringify(out, null, 1) + '\n');
  // 대시보드용: 러닝 한 건이 한 줄인 표 (Claude 러닝 대시보드가 매일 이 파일을 읽어 간다)
  writeFileSync(join(HERE, 'data', 'runs-rows.json'), JSON.stringify(toRows(runs)) + '\n');
  console.log('index.html, data/runs.json, data/runs-rows.json 을 갱신했습니다.');
}

main();
