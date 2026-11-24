/* Quiz Platform Documentation interactivity: copy buttons, TOC scroll-spy, mobile drawer, client-side search. */
(function () {
  const docLang = document.documentElement.lang === 'id' ? 'id' : 'en';
  const basePrefix = document.documentElement.dataset.base || '.';

  // 1. Mobile sidebar drawer
  const menuBtn = document.getElementById('menu-btn');
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  function setDrawer(open) {
    if (!sidebar) return;
    sidebar.classList.toggle('open', open);
    if (backdrop) backdrop.hidden = !open;
    if (menuBtn) menuBtn.setAttribute('aria-expanded', String(open));
  }
  if (menuBtn) menuBtn.addEventListener('click', () => setDrawer(!sidebar.classList.contains('open')));
  if (backdrop) backdrop.addEventListener('click', () => setDrawer(false));

  // 2. Preserve anchor hash when switching languages
  document.querySelectorAll('.lang-switch a').forEach((link) => {
    link.addEventListener('click', () => {
      if (window.location.hash && !link.href.includes('#')) {
        link.href += window.location.hash;
      }
    });
  });

  // 3. Copy-to-clipboard buttons for code blocks
  const copyLabel = docLang === 'id' ? 'Salin' : 'Copy';
  const copiedLabel = docLang === 'id' ? 'Disalin ✓' : 'Copied ✓';
  document.querySelectorAll('.code-block').forEach((block) => {
    const btn = block.querySelector('.copy-btn');
    const code = block.querySelector('pre code');
    if (!btn || !code) return;
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code.textContent);
        btn.textContent = copiedLabel;
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = copyLabel;
          btn.classList.remove('copied');
        }, 1800);
      } catch {
        // Fallback selection
        const range = document.createRange();
        range.selectNodeContents(code);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });
  });

  // 4. Right-hand TOC scroll-spy
  const tocLinks = Array.from(document.querySelectorAll('.toc a[href^="#"]'));
  if (tocLinks.length && 'IntersectionObserver' in window) {
    const headings = tocLinks
      .map((a) => document.getElementById(a.getAttribute('href').slice(1)))
      .filter(Boolean);
    const byId = new Map(tocLinks.map((a) => [a.getAttribute('href').slice(1), a]));
    const setActive = (id) => {
      tocLinks.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + id));
    };
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length) setActive(visible[0].target.id);
      },
      { rootMargin: '-72px 0px -70% 0px', threshold: 0 }
    );
    headings.forEach((h) => obs.observe(h));
    if (headings[0]) setActive(headings[0].id);
  }

  // 5. Client-side search modal
  const searchBtn = document.getElementById('search-trigger');
  const searchBackdrop = document.getElementById('search-backdrop');
  const searchInput = document.getElementById('search-input');
  const searchResults = document.getElementById('search-results');
  const searchClose = document.getElementById('search-close');
  let indexPromise = null;

  function loadIndex() {
    if (!indexPromise) {
      indexPromise = fetch(`${basePrefix}/assets/search-index.json`)
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => []);
    }
    return indexPromise;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function renderSearch(query) {
    if (!searchResults) return;
    const q = query.trim().toLowerCase();
    const entries = await loadIndex();
    const scoped = entries.filter((e) => e.lang === docLang);
    if (!q) {
      const hint = docLang === 'id'
        ? 'Ketik kata kunci (mis. AI, anti-curang, Caddy, backup, roda putar, TOEFL)…'
        : 'Type a keyword (e.g. AI, anti-cheat, Caddy, backup, wheel, TOEFL)…';
      searchResults.innerHTML = `<div class="search-empty">${hint}</div>`;
      return;
    }
    const terms = q.split(/\s+/).filter(Boolean);
    const scored = [];
    for (const item of scoped) {
      const titleL = item.title.toLowerCase();
      const pageL = item.pageTitle.toLowerCase();
      const textL = item.text.toLowerCase();
      let score = 0;
      let ok = true;
      for (const term of terms) {
        if (titleL.includes(term)) score += 10;
        else if (pageL.includes(term)) score += 6;
        else if (textL.includes(term)) score += 2;
        else { ok = false; break; }
      }
      if (ok && score > 0) scored.push({ item, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 12);
    if (!top.length) {
      const empty = docLang === 'id' ? 'Tidak ada hasil yang cocok.' : 'No matching documentation sections found.';
      searchResults.innerHTML = `<div class="search-empty">${empty}</div>`;
      return;
    }
    searchResults.innerHTML = top
      .map(({ item }) => {
        const href = `${basePrefix}/${item.url}`;
        const snippet = item.text.slice(0, 150) + (item.text.length > 150 ? '…' : '');
        return `<a class="search-item" href="${escapeHtml(href)}">
          <div class="search-item-meta">${escapeHtml(item.pageTitle)}</div>
          <div class="search-item-title">${escapeHtml(item.title)}</div>
          <div class="search-item-snippet">${escapeHtml(snippet)}</div>
        </a>`;
      })
      .join('');
  }

  function openSearch() {
    if (!searchBackdrop || !searchInput) return;
    searchBackdrop.hidden = false;
    searchInput.value = '';
    renderSearch('');
    setTimeout(() => searchInput.focus(), 10);
  }
  function closeSearch() {
    if (!searchBackdrop) return;
    searchBackdrop.hidden = true;
  }

  if (searchBtn) searchBtn.addEventListener('click', openSearch);
  if (searchClose) searchClose.addEventListener('click', closeSearch);
  if (searchBackdrop) {
    searchBackdrop.addEventListener('click', (e) => {
      if (e.target === searchBackdrop) closeSearch();
    });
  }
  if (searchInput) searchInput.addEventListener('input', (e) => renderSearch(e.target.value));

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (searchBackdrop && searchBackdrop.hidden) openSearch();
      else closeSearch();
    } else if (e.key === '/' && !e.target.closest('input, textarea, select') && searchBackdrop && searchBackdrop.hidden) {
      e.preventDefault();
      openSearch();
    } else if (e.key === 'Escape') {
      closeSearch();
      setDrawer(false);
    }
  });
})();
