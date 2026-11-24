// Anti-cheat mode, student side: tell the server when this page is left and when it is back.
// A browser cannot stop anyone switching tabs or apps; it can only notice. The record is kept
// on the server, so reloading does not clear it.
import { api, h, modal, onLeave, render, show, t } from './core.js';

let stop = () => {};
export const stopGuard = () => stop();

export function lockScreen(code, token) {
  stop();
  document.body.className = 'stage playing';
  show(h('section', { class: 'hero' }, h('h1', null, '🔒 ', t('guard_locked')), h('p', { class: 'lead' }, t('guard_locked_d')),
    h('p', { class: 'muted-light' }, h('span', { class: 'spinner light' }), ' ', t('guard_locked_wait'))));
  let off = false;
  const poll = async () => {
    if (off) return;
    try { const s = await api(`/play/${code}?peek=1`, { player: token }); if (!s.guard || !s.guard.locked) { off = true; return render(); } } catch { /* try again */ }
    setTimeout(poll, 4000);
  };
  setTimeout(poll, 4000);
  onLeave(() => { off = true; });
}

// Shows the rules once, then starts watching. Resolves false when the player is locked out.
export async function startGuard(code, token, g) {
  if (g.locked) { lockScreen(code, token); return false; }
  const key = 'quiz.guard.' + code;
  let seen = false;
  try { seen = sessionStorage.getItem(key) === '1'; } catch { /* private mode */ }
  if (!seen) {
    await new Promise((resolve) => {
      const rule = g.penalty === 'zero' ? t('guard_rule_zero') : g.penalty === 'lock' ? t('guard_rule_lock', { n: g.lock_after }) : t('guard_rule_record');
      show(h('section', { class: 'narrow card guard-intro' }, h('h1', null, '🛡 ', t('guard_title')),
        h('p', null, t('guard_intro')),
        h('ul', null, h('li', null, t('guard_do_1')), h('li', null, t('guard_do_2')), h('li', null, h('strong', null, rule))),
        h('button', { class: 'btn big', onclick: () => {
          try { sessionStorage.setItem(key, '1'); } catch { /* private mode */ }
          // Fullscreen needs this click; phones mostly refuse it, which is fine.
          if (document.fullscreenEnabled && matchMedia('(pointer: fine)').matches) document.documentElement.requestFullscreen().catch(() => {});
          resolve();
        } }, t('guard_start'))));
    });
  }
  watch(code, token);
  return true;
}

function watch(code, token) {
  stop();
  let away = false, how = '', left = 0, sending = Promise.resolve(), ended = false, closeNote = null;
  let wasFull = !!document.fullscreenElement;
  document.body.classList.add('guarded');

  const leave = (kind) => {
    if (away || ended) return;
    away = true;
    how = kind;
    left = Date.now();
    sending = api(`/play/${code}/away`, { method: 'POST', player: token, body: { kind }, keepalive: true }).catch(() => {});
  };
  const comeBack = async () => {
    if (!away || ended) return;
    away = false;
    const ms = Date.now() - left;
    await sending;  // keep the order: "away" first, then "back"
    let r;
    try { r = await api(`/play/${code}/back`, { method: 'POST', player: token, body: { ms } }); } catch { return; }
    if (!r || r.ignored || !r.counted || ended) return;
    if (r.locked) return lockScreen(code, token);
    if (closeNote) closeNote();
    closeNote = modal('⚠ ' + t('guard_warn_title'), h('div', { class: 'stack' },
      h('p', null, t('guard_warn', { n: r.exits, s: Math.round(ms / 1000) })),
      r.zeroed ? h('p', { class: 'form-error' }, t('guard_warn_zero')) : null,
      r.penalty === 'lock' ? h('p', { class: 'form-error' }, t('guard_warn_lock', { n: r.lock_after })) : null),
    [h('button', { class: 'btn', onclick: () => { closeNote(); closeNote = null; } }, t('guard_ok'))]);
  };

  // Each kind of exit ends only with its own return: entering fullscreen does not excuse a hidden page.
  const onVisibility = () => { if (document.hidden) leave('hidden'); else if (how !== 'fullscreen') comeBack(); };
  const onBlur = () => { if (!document.hidden) leave('blur'); };
  // Focus only means "back" when the page can actually be seen; a hidden page that gets focus is still away.
  const onFocus = () => { if (!document.hidden && how === 'blur') comeBack(); };
  const onFullscreen = () => {
    if (document.fullscreenElement) { wasFull = true; if (how === 'fullscreen') comeBack(); return; }
    if (!wasFull) return;
    wasFull = false;
    leave('fullscreen');
    const close = modal(t('guard_fs_title'), h('p', null, t('guard_fs')), [h('button', { class: 'btn', onclick: () => {
      close();
      document.documentElement.requestFullscreen().catch(() => comeBack());
    } }, t('guard_fs_back'))]);
  };
  const block = (e) => { if (!e.target.closest || !e.target.closest('.modal')) e.preventDefault(); };

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', onFocus);
  document.addEventListener('fullscreenchange', onFullscreen);
  for (const type of ['copy', 'cut', 'paste', 'contextmenu']) document.addEventListener(type, block);

  stop = () => {
    ended = true;
    document.body.classList.remove('guarded');
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('fullscreenchange', onFullscreen);
    for (const type of ['copy', 'cut', 'paste', 'contextmenu']) document.removeEventListener(type, block);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    stop = () => {};
  };
  onLeave(() => stop());
}
