// 유튜브 채널 RSS 를 읽어 index.html 의 '최신 영상' 자리를 채운다.
// 깃허브 액션이 주기적으로 돌리고, 바뀐 게 있을 때만 커밋한다.
//
//   node build.mjs
//
// RSS 는 최근 15개까지만 준다. 토큰도 승인도 필요 없다.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  channelId: 'UChaaZzKxKoZBqmkXMBugDyg',
  count: 6,
};

const FEED = `https://www.youtube.com/feeds/videos.xml?channel_id=${CONFIG.channelId}`;
const START = '<!-- videos:start -->';
const END = '<!-- videos:end -->';

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const pick = (xml, tag) => {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : '';
};

// 깃허브 액션은 UTC 로 도는데 보는 사람은 한국에 있다. 한국 시간으로 고정하지
// 않으면 밤늦게 올린 영상이 하루 전 날짜로 찍히고, 로컬에서 돌릴 때마다 뒤집힌다.
const fmtDate = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const [y, m, day] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d).split('-');
  return `${y}.${m}.${day}`;
};

function parseFeed(xml) {
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  return entries.map((entry) => {
    const id = pick(entry, 'yt:videoId');
    const thumb = entry.match(/<media:thumbnail[^>]*url="([^"]+)"/)?.[1] ?? '';
    return {
      id,
      title: pick(entry, 'title'),
      date: pick(entry, 'published'),
      // 썸네일은 유튜브 서버에서 바로 불러도 막히지 않는다.
      thumb: thumb || (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : ''),
      link: id ? `https://www.youtube.com/watch?v=${id}` : '',
    };
  });
}

const card = (video) => `
    <a class="item" href="${esc(video.link)}" target="_blank" rel="noopener">
      <span class="ph" style="aspect-ratio:16/9">
        ${video.thumb ? `<img src="${esc(video.thumb)}" alt="" loading="lazy" decoding="async">` : ''}
        <span class="play"><svg width="18" height="18" viewBox="0 0 24 24" fill="var(--bg)" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg></span>
      </span>
      <h3>${esc(video.title)}</h3>
      <span class="sub">${esc(fmtDate(video.date))}</span>
    </a>`;

const empty = `
    <div class="item"><div class="ph" style="aspect-ratio:16/9">영상을 불러오지 못했습니다</div></div>`;

async function main() {
  let videos = [];
  try {
    const res = await fetch(FEED, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    videos = parseFeed(await res.text()).slice(0, CONFIG.count);
    console.log(`영상 ${videos.length}개를 받았습니다.`);
  } catch (err) {
    console.error(`영상을 받지 못했습니다: ${err.message}`);
  }

  const path = join(HERE, 'index.html');
  const html = readFileSync(path, 'utf8');
  const from = html.indexOf(START);
  const to = html.indexOf(END);
  if (from < 0 || to < 0) {
    console.error(`index.html 에서 ${START} / ${END} 표시를 찾지 못했습니다.`);
    process.exit(1);
  }

  // 영상을 못 받았으면 기존 내용을 그대로 둔다. 빈 화면을 내보내지 않기 위해서다.
  if (!videos.length) {
    console.log('기존 내용을 그대로 둡니다.');
    return;
  }

  const next =
    html.slice(0, from + START.length) +
    '\n' +
    videos.map(card).join('\n') +
    '\n  ' +
    html.slice(to);

  if (next === html) {
    console.log('바뀐 게 없습니다.');
    return;
  }
  writeFileSync(path, next);
  console.log('index.html 을 갱신했습니다.');
}

main();
