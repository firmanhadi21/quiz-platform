// Shared plumbing: language, DOM builder, API calls, router, dialogs.
import { STRINGS } from './strings.js';

export const state = { user: null, registration: true, ai: false };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};
export { store };

// ---- language
export function lang() { return store.get('quiz.lang') === 'en' ? 'en' : 'id'; }
export function setLang(l) { store.set('quiz.lang', l); document.documentElement.lang = l; }
export function t(key, vars) {
  const pair = STRINGS[key];
  let s = pair ? pair[lang() === 'en' ? 1 : 0] : key;
  if (vars) for (const k in vars) s = s.replaceAll(`{${k}}`, vars[k]);
  return s;
}

// ---- DOM: h('div', {class: 'x', onclick: fn}, 'text', child, [more])
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'autofocus') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  add(el, kids);
  return el;
}
function add(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) add(el, k);
    else el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
}
export const $app = () => document.getElementById('app');
export function show(...kids) { const a = $app(); a.replaceChildren(); add(a, kids); window.scrollTo(0, 0); }

// ---- API
export async function api(path, { method = 'GET', body, player, raw, keepalive } = {}) {
  const headers = { 'X-Quiz': '1', 'X-Lang': lang() };
  if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
  if (player) headers['X-Player'] = player;
  let r;
  try {
    r = await fetch('/api' + path, { method, headers, credentials: 'same-origin', keepalive: !!keepalive,
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  } catch { const e = new Error(t('err_net')); e.status = 0; throw e; }
  let data = null;
  try { data = await r.json(); } catch { /* empty body */ }
  if (!r.ok) {
    const e = new Error((data && typeof data.detail === 'string' && data.detail) || t('err_net'));
    e.status = r.status;
    throw e;
  }
  return data;
}
export async function loadMe() {
  const me = await api('/me');
  state.user = me.user;
  state.registration = me.registration;
  state.ai = me.ai;
  state.site = me.site;
  applySite(me.site);
}

// Site name, logo and colours come from the server, so each install can carry its own brand.
export function applySite(site) {
  if (!site) return;
  document.title = site.name;
  const name = document.getElementById('brand-name'), mark = document.getElementById('brand-mark');
  if (name) name.textContent = site.name;
  if (mark) mark.replaceChildren(site.logo ? h('img', { src: site.logo, alt: '' }) : (site.name.trim()[0] || 'Q').toUpperCase());
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = site.primary;
  const icon = document.querySelector('link[rel=icon]');
  if (icon && site.logo) icon.href = site.logo;
  const css = document.querySelector('link[href^="/brand.css"]');
  if (css) css.href = '/brand.css?v=' + encodeURIComponent(site.primary + site.accent);
}

// ---- router
const routes = [];
let leave = [];
export function route(pattern, handler) { routes.push([pattern, handler]); }
export function onLeave(fn) { leave.push(fn); }
export function go(path, replace) {
  if (replace) history.replaceState(null, '', path); else history.pushState(null, '', path);
  render();
}
export function render() {
  for (const fn of leave) { try { fn(); } catch { /* ignore */ } }
  leave = [];
  document.body.className = '';
  const path = location.pathname.replace(/\/+$/, '') || '/';
  for (const [pattern, handler] of routes) {
    const match = pattern.exec(path);
    if (match) {
      Promise.resolve(handler(...match.slice(1).map(decodeURIComponent))).catch(fatal);
      document.dispatchEvent(new Event('quiz:route'));
      return;
    }
  }
  show(h('section', { class: 'narrow center' }, h('h1', null, '404'), h('p', null, t('notfound')),
    h('a', { class: 'btn', href: '/' }, t('home'))));
}
export function fatal(err) {
  if (err && err.status === 401 && !state.user) return go('/login?next=' + encodeURIComponent(location.pathname + location.search), true);
  show(h('section', { class: 'narrow center' }, h('h1', null, t('oops')), h('p', null, (err && err.message) || t('err_net')),
    h('a', { class: 'btn', href: '/' }, t('home'))));
}
export const canTeach = () => !!state.user && state.user.role !== 'student';
export function needTeacher() {
  if (!needUser()) return false;
  if (canTeach()) return true;
  show(h('section', { class: 'narrow center card' }, h('h1', null, t('teacher_only')), h('p', null, t('teacher_only_d')),
    h('div', { class: 'row center' }, h('a', { class: 'btn', href: '/explore' }, t('explore')), h('a', { class: 'btn ghost', href: '/results' }, t('my_results')))));
  return false;
}
export function needUser() {
  if (state.user) return true;
  go('/login?next=' + encodeURIComponent(location.pathname + location.search), true);
  return false;
}
window.addEventListener('popstate', render);
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href^="/"]');
  if (!a || a.target || a.hasAttribute('download') || e.metaKey || e.ctrlKey || e.shiftKey) return;
  if (a.getAttribute('href').startsWith('/api/')) return;
  e.preventDefault();
  go(a.getAttribute('href'));
});

// ---- small UI pieces
export function toast(text, bad) {
  document.querySelectorAll('.toast').forEach((old) => old.remove());
  const el = h('div', { class: 'toast' + (bad ? ' bad' : ''), role: 'status' }, text);
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}
export function modal(title, body, buttons = []) {
  const close = () => { wrap.remove(); document.removeEventListener('keydown', esc); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const wrap = h('div', { class: 'modal-wrap', onclick: (e) => { if (e.target === wrap) close(); } },
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('header', null, h('h2', null, title), h('button', { class: 'icon', 'aria-label': t('close'), onclick: close }, '×')),
      h('div', { class: 'modal-body' }, body),
      buttons.length ? h('footer', null, buttons) : null));
  document.addEventListener('keydown', esc);
  document.body.append(wrap);
  const first = wrap.querySelector('input, textarea, select, .modal-body button, footer button');
  if (first) first.focus();
  return close;
}
export function confirmBox(text, yes, onYes) {
  const close = modal(t('confirm'), h('p', null, text), [
    h('button', { class: 'btn ghost', onclick: () => close() }, t('cancel')),
    h('button', { class: 'btn danger', onclick: () => { close(); onYes(); } }, yes)]);
}
export function when(ts) {
  return new Date(ts * 1000).toLocaleString(lang() === 'en' ? 'en-GB' : 'id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}
export function qr(text, size = 6) {
  const code = window.qrcode(0, 'M');
  code.addData(text);
  code.make();
  return h('img', { class: 'qr', alt: 'QR ' + text, src: code.createDataURL(size, 2) });
}
export async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast(t('copied')); } catch { toast(text); }
}
export const joinUrl = (code) => `${location.origin}/join/${code}`;
export const prettyCode = (code) => `${code.slice(0, 3)} ${code.slice(3)}`;
export const playerToken = (code, value) => (value === undefined ? store.get('quiz.p.' + code) : store.set('quiz.p.' + code, value));
export const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
export const spinner = () => h('div', { class: 'loading' }, h('span', { class: 'spinner' }), t('loading'));
export const typeName = (type) => t('type_' + type);
