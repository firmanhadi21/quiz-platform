// Entry point: header, routes, start-up.
import { api, canTeach, fatal, go, h, lang, loadMe, render, route, setLang, state, t } from './core.js';
import { auth, dashboard, explore, home, join, quizPage, results } from './pages.js';
import { editor } from './editor.js';
import { play } from './play.js';
import { host } from './host.js';
import { report } from './report.js';
import { wheel } from './wheel.js';
import { accountPage, adminPage } from './admin.js';
import { reviewPage } from './review.js';

function header() {
  const nav = document.getElementById('nav');
  const here = location.pathname;
  const link = (href, label) => h('a', { href, class: here === href ? 'on' : '' }, label);
  nav.replaceChildren(
    link('/explore', t('nav_explore')), link('/wheel', t('f_wheel')),
    ...(state.user
      ? [canTeach() ? link('/dashboard', t('dashboard')) : link('/results', t('my_results')),
        state.user.role === 'admin' ? link('/admin', 'Admin') : '',
        h('a', { href: '/account', class: 'nav-user' + (here === '/account' ? ' on' : ''), title: state.user.email }, state.user.name.split(' ')[0]),
        h('button', { class: 'nav-btn', title: state.user.email, onclick: async () => { try { await api('/auth/logout', { method: 'POST' }); } catch { /* signed out anyway */ } state.user = null; go('/'); } }, t('logout'))]
      : [link('/login', t('login')), h('a', { href: '/register', class: 'nav-cta' }, t('register'))]),
    h('button', { class: 'nav-btn lang', 'aria-label': 'Bahasa / Language', onclick: () => { setLang(lang() === 'en' ? 'id' : 'en'); render(); } }, lang() === 'en' ? 'ID' : 'EN'));
}
document.addEventListener('quiz:route', header);

route(/^\/$/, home);
route(/^\/join$/, () => join(new URLSearchParams(location.search).get('code')));
route(/^\/join\/(\d{6})$/, join);
route(/^\/(\d{6})$/, (code) => go('/join/' + code, true));
route(/^\/play\/(\d{6})$/, play);
route(/^\/login$/, () => auth('login'));
route(/^\/register$/, () => auth('register'));
route(/^\/dashboard$/, dashboard);
route(/^\/explore$/, explore);
route(/^\/results$/, results);
route(/^\/quiz\/([a-z0-9]{8})$/, quizPage);
route(/^\/edit\/(new|[a-z0-9]{8})$/, editor);
route(/^\/host\/(\d{6})$/, host);
route(/^\/report\/(\d{6})$/, report);
route(/^\/wheel$/, wheel);
route(/^\/admin$/, adminPage);
route(/^\/account$/, accountPage);
route(/^\/review\/(\d{6})$/, reviewPage);

setLang(lang());
loadMe().catch(() => {}).then(render).catch(fatal);
