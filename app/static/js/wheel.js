// Spin the wheel: names or topics, one per line. Works without an account; saving needs one.
import { api, confirmBox, h, modal, onLeave, show, state, store, t, toast } from './core.js';

const COLORS = ['#0f6b5f', '#c8860a', '#b03a2e', '#2a6fb0', '#7a4fa3', '#1f7a4d', '#c2552d', '#3d5a80'];
const TAU = Math.PI * 2;
// A line is either a name, or "number | name": the wheel then shows the number and the result shows the name.
export function parseEntry(line) {
  const m = /^([^|\t]{1,8}?)\s*[|\t]\s*(.+)$/.exec(line);
  return m ? { number: m[1].trim(), name: m[2].trim(), label: m[1].trim() } : { number: '', name: line, label: line };
}

function randomInt(n) {  // unbiased pick in [0, n)
  const limit = Math.floor(0xffffffff / n) * n;
  const buf = new Uint32Array(1);
  do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
  return buf[0] % n;
}

export function drawWheel(canvas, items, angle) {
  const size = canvas.width, r = size / 2, ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const n = Math.max(items.length, 1), step = TAU / n;
  for (let i = 0; i < n; i++) {
    ctx.beginPath();
    ctx.moveTo(r, r);
    ctx.arc(r, r, r - 6, angle + i * step, angle + (i + 1) * step);
    ctx.closePath();
    // With an odd count the last slice would touch the first in the same colour.
    ctx.fillStyle = COLORS[(i === n - 1 && n > 1 && i % COLORS.length === 0 ? 1 : i) % COLORS.length];
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.55)';
    ctx.lineWidth = 2;
    ctx.stroke();
    if (!items.length) continue;
    ctx.save();
    ctx.translate(r, r);
    ctx.rotate(angle + (i + 0.5) * step);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const px = Math.max(11, Math.min(parseEntry(items[i]).number ? 46 : 34, (step * r * 0.62), size / 18));
    ctx.font = `600 ${px}px ui-sans-serif, system-ui, sans-serif`;
    let label = parseEntry(items[i]).label;
    while (label.length > 3 && ctx.measureText(label).width > r * 0.68) label = label.slice(0, -2).trimEnd() + '…';
    ctx.fillText(label, r - 22, 0);
    ctx.restore();
  }
  ctx.beginPath();
  ctx.arc(r, r, r * 0.11, 0, TAU);
  ctx.fillStyle = '#fbf9f4';
  ctx.fill();
}

export async function wheel() {
  const params = new URLSearchParams(location.search);
  let items = [], angle = -Math.PI / 2, spinning = false, raf = 0, current = null;
  const saved = state.user ? await api('/wheels') : [];
  const draft = store.get('quiz.wheel');
  const title = h('input', { maxlength: '100', placeholder: t('wheel_title_ph'), 'aria-label': t('title') });
  const area = h('textarea', { rows: '12', placeholder: t('wheel_ph'), 'aria-label': t('wheel_items') });
  const canvas = h('canvas', { width: '900', height: '900', class: 'wheel-canvas', role: 'img', 'aria-label': t('f_wheel') });
  const count = h('span', { class: 'muted small' });
  const spinBtn = h('button', { class: 'btn big wheel-spin', onclick: () => spin() }, t('spin'));
  const live = h('p', { class: 'sr', 'aria-live': 'polite' });
  const list = h('div', { class: 'stack' });
  const sheet = h('input', { type: 'file', accept: '.xlsx,.csv,.txt,text/csv', hidden: true, onchange: async () => {
    const f = sheet.files[0];
    if (!f) return;
    try {
      const { entries } = await api('/wheels/sheet', { method: 'POST', body: f, raw: true });
      current = null;
      setItems(entries.map((e) => (e.number ? `${e.number} | ${e.name}` : e.name)), f.name.replace(/\.[^.]+$/, ''));
      if (state.user) drawSaved(await api('/wheels'));
      toast(t('wheel_loaded', { n: entries.length }));
    } catch (e) { toast(e.message, true); }
    sheet.value = '';
  } });
  const template = () => {
    const a = h('a', { href: URL.createObjectURL(new Blob(['\ufeffNo,Nama\n1,Ani Wijaya\n2,Budi Santoso\n3,Citra Lestari\n'], { type: 'text/csv' })), download: 'daftar-kelas.csv' });
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const read = () => {
    items = area.value.split('\n').map((s) => s.trim().slice(0, 60)).filter(Boolean).slice(0, 200);
    count.textContent = t('n_entries', { n: items.length });
    spinBtn.disabled = items.length < 2 || spinning;
    store.set('quiz.wheel', area.value);
    drawWheel(canvas, items, angle);
  };
  const setItems = (list2, name) => { area.value = list2.join('\n'); if (name !== undefined) title.value = name; read(); };
  area.addEventListener('input', read);

  function spin() {
    if (spinning || items.length < 2) return;
    spinning = true;
    spinBtn.disabled = true;
    const n = items.length, step = TAU / n, win = randomInt(n);
    // The pointer sits at the top (-90°). Land somewhere inside the winning slice, not on its edge.
    const inside = (0.15 + 0.7 * (randomInt(1000) / 1000)) * step;
    const target = -Math.PI / 2 - (win * step + inside);
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const turns = calm ? 1 : 6;
    const from = angle, delta = ((target - from) % TAU + TAU) % TAU + turns * TAU;
    const duration = calm ? 900 : 5200, t0 = performance.now();
    const frame = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      angle = from + delta * (1 - Math.pow(1 - p, 4));
      drawWheel(canvas, items, angle);
      if (p < 1) { raf = requestAnimationFrame(frame); return; }
      angle %= TAU;
      spinning = false;
      announce(win);
    };
    raf = requestAnimationFrame(frame);
  }
  function announce(win) {
    const line = items[win], entry = parseEntry(line), name = entry.name;
    live.textContent = t('winner_is', { name: entry.number ? `${entry.number}, ${name}` : name });
    const drop = () => { const lines = area.value.split('\n'); const at = lines.findIndex((l) => l.trim().slice(0, 60) === line); if (at >= 0) lines.splice(at, 1); area.value = lines.join('\n'); };
    const close = modal(t('winner'), h('div', null, entry.number ? h('p', { class: 'winner-no' }, t('number_short'), ' ', entry.number) : null, h('p', { class: 'winner' }, name)), [
      h('button', { class: 'btn ghost', onclick: () => { close(); read(); } }, t('keep')),
      h('button', { class: 'btn', onclick: () => { drop(); close(); read(); } }, t('remove_winner'))]);
    read();
  }

  const save = async () => {
    read();
    try {
      const body = { title: title.value.trim() || t('f_wheel'), items };
      if (current) await api('/wheels/' + current, { method: 'PUT', body });
      else current = (await api('/wheels', { method: 'POST', body })).id;
      toast(t('saved'));
      drawSaved(await api('/wheels'));
    } catch (e) { toast(e.message, true); }
  };
  function drawSaved(all) {
    list.replaceChildren(...(all.length ? all.map((w) => h('div', { class: 'saved' + (w.id === current ? ' on' : '') },
      h('button', { class: 'link', onclick: () => { current = w.id; setItems(w.items, w.title); drawSaved(all); } }, w.title, h('small', null, ' ', t('n_entries', { n: w.items.length }))),
      h('button', { class: 'icon', 'aria-label': t('delete'), onclick: () => confirmBox(t('delete_wheel_q', { title: w.title }), t('delete'), async () => {
        try { await api('/wheels/' + w.id, { method: 'DELETE' }); if (current === w.id) current = null; drawSaved(await api('/wheels')); } catch (e) { toast(e.message, true); }
      }) }, '×'))) : [h('p', { class: 'muted small' }, t('no_wheels'))]));
  }

  show(h('section', { class: 'wheel-page' },
    h('div', { class: 'wheel-stage' }, h('div', { class: 'wheel-wrap' }, h('span', { class: 'wheel-pointer', 'aria-hidden': 'true' }), canvas), spinBtn, live),
    h('div', { class: 'wheel-side stack' },
      h('h1', null, t('f_wheel')),
      h('div', { class: 'row' }, sheet, h('button', { class: 'btn small', onclick: () => sheet.click() }, '⬆ ', t('wheel_upload')),
        h('button', { class: 'link small', onclick: template }, t('wheel_template'))),
      h('p', { class: 'muted small' }, t('wheel_format')),
      title, area,
      h('div', { class: 'row' }, count, h('span', { class: 'spacer' }),
        h('button', { class: 'btn small ghost', onclick: () => { const a = area.value.split('\n').filter((s) => s.trim()); for (let i = a.length - 1; i > 0; i--) { const j = randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } area.value = a.join('\n'); read(); } }, t('shuffle')),
        h('button', { class: 'btn small ghost', onclick: () => { area.value = area.value.split('\n').filter((s) => s.trim()).sort((a, b) => a.localeCompare(b)).join('\n'); read(); } }, 'A→Z')),
      state.user ? [h('div', { class: 'row' }, h('button', { class: 'btn', onclick: save }, t('save')),
        h('button', { class: 'btn ghost', onclick: () => { current = null; setItems([], ''); drawSaved(saved); } }, t('new_wheel'))),
        h('h2', null, t('saved_wheels')), list]
        : h('p', { class: 'muted small' }, h('a', { href: '/login?next=/wheel' }, t('login')), ' ', t('login_to_save')))));
  if (state.user) drawSaved(saved);

  const game = params.get('game');
  if (game && state.user) {
    try { setItems(await api(`/games/${game}/players`), `${t('players')} ${game}`); } catch (e) { toast(e.message, true); setItems((draft || '').split('\n')); }
  } else setItems((draft || t('wheel_sample')).split('\n'));
  onLeave(() => cancelAnimationFrame(raf));
}
