// Teacher screens: the projector view of a live game, and the report of any game.
import { api, confirmBox, go, h, joinUrl, needTeacher, onLeave, prettyCode, qr, show, spinner, t, toast } from './core.js';
import { answerKey, attachPassage, clock, podium, questionHead, showReading } from './play.js';

export function distCounts(q, dist) {
  if (q.type === 'tf') return [dist.true || 0, dist.false || 0];
  if (q.options) return q.options.map((_, i) => dist[i] || 0);
  return null;
}
export function textCloud(dist) {
  const top = Object.entries(dist).sort((a, b) => b[1] - a[1]).slice(0, 12);
  return top.length ? h('div', { class: 'cloud' }, top.map(([k, n]) => h('span', null, k === '-' ? '∅' : k, ' ', h('b', null, n)))) : null;
}

export async function host(code) {
  if (!needTeacher()) return;
  document.body.className = 'stage playing';
  show(spinner());
  const info = await api('/games/' + code);
  if (!info.host || info.mode !== 'live') return go('/report/' + code, true);
  let ws, closed = false, retry = 0, timer = null, progress = null;
  const stopTimer = () => { if (timer) timer.stop(); timer = null; };
  const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
  // Anti-cheat: who left the quiz page, shown in a corner of the host screen.
  const flags = new Map();
  const flagBox = h('div', { class: 'flags', hidden: true });
  document.body.append(flagBox);
  onLeave(() => flagBox.remove());
  const drawFlags = () => {
    const shown = [...flags.values()].filter((f) => f.exits || f.away);
    flagBox.hidden = !shown.length;
    flagBox.replaceChildren(h('strong', null, '⚠ ', t('guard_flags')), ...shown.map((f) => h('div', { class: 'flag' + (f.away ? ' away' : '') },
      h('span', null, f.name), h('b', null, f.exits, '×'), f.away ? h('em', null, t('flag_away')) : null,
      f.locked ? h('button', { class: 'btn small light', onclick: async () => { try { await api(`/games/${code}/unlock`, { method: 'POST', body: { name: f.name } }); f.locked = false; drawFlags(); } catch (e) { toast(e.message, true); } } }, t('unlock')) : null)));
  };
  const top = (right) => h('div', { class: 'host-bar' }, h('span', null, info.title),
    h('span', { class: 'mono' }, location.host, ' · ', prettyCode(code)), right,
    h('button', { class: 'btn small ghost-light', onclick: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {})) }, '⛶'),
    h('button', { class: 'btn small ghost-light', onclick: () => confirmBox(t('end_game_q'), t('end_game'), () => send({ t: 'end' })) }, t('end_game')));

  function handle(m) {
    if (m.t === 'lobby') {
      stopTimer();
      show(h('section', { class: 'host' }, top(),
        h('div', { class: 'lobby' },
          h('div', { class: 'lobby-join' }, h('p', { class: 'eyebrow light' }, t('join_at')), h('p', { class: 'lobby-url' }, location.host),
            h('p', { class: 'eyebrow light' }, t('game_code')), h('p', { class: 'lobby-code' }, prettyCode(code))),
          qr(joinUrl(code), 7)),
        h('div', { class: 'row center' },
          h('strong', { class: 'lobby-count' }, t('n_players', { n: m.count })),
          h('button', { class: 'btn big light', disabled: !m.count, onclick: () => send({ t: 'next' }) }, '▶ ', t('start')),
          h('a', { class: 'btn ghost-light', href: '/wheel?game=' + code, target: '_blank' }, '◔ ', t('f_wheel'))),
        h('div', { class: 'chips' }, m.players.map((name) => h('button', { class: 'chip', title: t('kick_hint'),
          onclick: () => confirmBox(t('kick_q', { name }), t('kick'), () => send({ t: 'kick', name })) }, name))),
        m.count ? null : h('p', { class: 'muted-light center' }, t('lobby_wait'))));
    } else if (m.t === 'question') {
      stopTimer();
      timer = clock(m.ms_left, m.q.time);
      progress = h('strong', { class: 'answered' }, '0');
      show(h('section', { class: 'host' }, top(h('span', null, t('q_of', { a: m.qi + 1, b: m.total }))),
        timer, questionHead(m.q), m.q.type === 'text' ? h('p', { class: 'lead center' }, t('type_answer')) : answerKey(m.q, null, null),
        h('div', { class: 'row center' }, h('span', { class: 'lead' }, progress, ' ', t('answered_n')),
          h('button', { class: 'btn light', onclick: () => send({ t: 'reveal' }) }, t('close_question')))));
    } else if (m.t === 'progress') {
      if (progress) progress.textContent = `${m.answered} / ${m.players}`;
    } else if (m.t === 'reveal') {
      stopTimer();
      progress = null;
      const counts = distCounts(m.q, m.dist);
      show(h('section', { class: 'host' }, top(h('span', null, t('q_of', { a: m.qi + 1, b: m.total }))),
        questionHead(m.q),
        counts ? answerKey(m.q, m.answer, null, counts) : [answerKey(m.q, m.answer, null), textCloud(m.dist)],
        m.explanation ? h('p', { class: 'explain' }, m.explanation) : null,
        h('div', { class: 'host-foot' },
          h('div', null, m.q.type === 'poll' ? h('p', { class: 'lead' }, t('answered_of', { a: m.answered, b: m.players }))
            : h('p', { class: 'lead' }, t('correct_of', { a: m.correct, b: m.answered })),
            h('button', { class: 'btn big light', onclick: () => send({ t: 'next' }) }, m.last ? t('show_final') : t('next_question'), ' →')),
          m.top.length ? h('div', null, h('p', { class: 'eyebrow light' }, t('leaderboard')), podium(m.top)) : null)));
    } else if (m.t === 'ended') {
      closed = true;
      stopTimer();
      show(h('section', { class: 'host' }, h('div', { class: 'center' }, h('p', { class: 'eyebrow light' }, info.title), h('h1', null, t('final'))),
        m.top.length ? podium(m.top) : h('p', { class: 'muted-light center' }, t('no_players')),
        h('div', { class: 'row center' },
          h('a', { class: 'btn big light', href: '/report/' + code }, '▤ ', t('results_dash')),
          h('a', { class: 'btn big ghost-light', href: '/review/' + code }, '▶ ', t('review_btn')),
          h('a', { class: 'btn ghost-light', href: '/wheel?game=' + code }, '◔ ', t('f_wheel')),
          h('a', { class: 'btn ghost-light', href: '/dashboard' }, t('dashboard')))));
    }
  }
  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${code}?role=host`);
    ws.onopen = () => { retry = 0; };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      handle(m);
      if (m.t === 'flag') { flags.set(m.name, m); drawFlags(); }
      if (m.t === 'reading') {
        stopTimer();
        showReading(m.passage, m.qi, h('div', { class: 'row center' }, h('button', { class: 'btn big light', onclick: () => send({ t: 'next' }) }, '▶ ', t('start_questions')),
          h('button', { class: 'btn ghost-light', onclick: () => confirmBox(t('end_game_q'), t('end_game'), () => send({ t: 'end' })) }, t('end_game'))));
      } else if (m.t === 'question' || m.t === 'reveal') attachPassage(m.passage);
    };
    ws.onclose = (e) => {
      if (closed) return;
      if (e.code === 4403 || e.code === 4404) return go('/dashboard', true);
      retry += 1;
      toast(t('reconnecting'), true);
      setTimeout(() => { if (!closed) connect(); }, Math.min(8000, 800 * retry));
    };
  }
  connect();
  onLeave(() => { closed = true; stopTimer(); if (ws) ws.close(); });
}

