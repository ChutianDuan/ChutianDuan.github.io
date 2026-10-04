(() => {
  const initializeKnowledgeNavigation = () => {
    const headingOffset = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-height')) + 18;
    const nextUtils = window.NexT?.utils;
    if (document.querySelector('.main-inner.post') && nextUtils) {
      // Keep NexT's section list and highlighting, but account for our fixed header.
      nextUtils.updateActiveNav = function() {
        if (!Array.isArray(this.sections) || !this.sections.length) return;
        const upcoming = this.sections.findIndex(section => section?.getBoundingClientRect().top > headingOffset() + 1);
        this.activateNavByIndex(upcoming === -1 ? this.sections.length - 1 : Math.max(0, upcoming - 1));
      };
      nextUtils.updateActiveNav();
      window.addEventListener('resize', () => nextUtils.updateActiveNav());
    }
    const popup = document.querySelector('.search-popup');
    const overlay = document.querySelector('.search-pop-overlay');
    const input = popup?.querySelector('.search-input');
    if (popup && overlay && input) {
      popup.setAttribute('role', 'dialog');
      popup.setAttribute('aria-modal', 'true');
      popup.setAttribute('aria-label', '搜索全部工程笔记');
      input.setAttribute('aria-label', '搜索文章标题与正文');
      overlay.setAttribute('aria-hidden', 'true');
      let returnFocus = null;
      let active = false;
      let loaded = false;
      const isolated = new Map();
      const triggers = document.querySelectorAll('.popup-trigger, .popup-btn-close');
      triggers.forEach(trigger => {
        if (trigger.tagName !== 'BUTTON') {
          trigger.tabIndex = 0;
          trigger.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              trigger.click();
            }
          });
        }
        trigger.setAttribute('aria-label', trigger.matches('.popup-btn-close') ? '关闭搜索' : '搜索文章（⌘K / Ctrl+K）');
      });
      document.querySelector('.menu-item-search .popup-trigger')?.insertAdjacentHTML('beforeend', '<kbd class="search-shortcut">⌘K / Ctrl+K</kbd>');
      const status = document.createElement('p');
      status.className = 'engineering-search-status';
      status.setAttribute('role', 'status');
      popup.querySelector('.search-header').after(status);
      const results = popup.querySelector('.search-result-container');
      const updateStatus = () => {
        const count = results.querySelectorAll('.search-result-list > li').length;
        results.querySelector('.search-stats')?.setAttribute('role', 'status');
        status.textContent = !input.value.trim() ? '搜索全站笔记的标题与正文。' : count ? '' : loaded ? '没有找到匹配文章，请换一个关键词。' : '正在加载搜索索引…';
      };
      input.addEventListener('input', updateStatus);
      window.addEventListener('search:loaded', () => { loaded = true; updateStatus(); });
      new MutationObserver(updateStatus).observe(results, { childList: true, subtree: true });
      updateStatus();

      document.addEventListener('click', event => {
        const trigger = event.target.closest('.popup-trigger');
        if (trigger && !active) returnFocus = trigger;
      }, true);
      document.addEventListener('keydown', event => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !active) {
          returnFocus = document.activeElement;
        }
        if (!active || event.key !== 'Tab') return;
        const focusable = [...popup.querySelectorAll('input, button, a[href], [tabindex="0"]')].filter(element => element.getClientRects().length);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }, true);
      document.addEventListener('focusin', event => {
        if (active && !popup.contains(event.target)) input.focus();
        // NexT delays input focus; a quick Escape must not focus the closed dialog.
        if (!active && popup.contains(event.target)) returnFocus?.focus();
      });
      new MutationObserver(() => {
        const nextActive = document.body.classList.contains('search-active');
        if (nextActive === active) return;
        active = nextActive;
        overlay.setAttribute('aria-hidden', String(!active));
        if (active) {
          if (!returnFocus) returnFocus = document.activeElement;
          // The dialog is inside .column; isolate siblings without hiding its ancestor.
          for (let node = overlay; node.parentElement && node !== document.body; node = node.parentElement) {
            for (const sibling of node.parentElement.children) {
              if (sibling === node || !(sibling instanceof HTMLElement) || /^(SCRIPT|STYLE|LINK)$/.test(sibling.tagName)) continue;
              isolated.set(sibling, sibling.inert);
              sibling.inert = true;
            }
          }
          input.focus();
        } else {
          isolated.forEach((wasInert, element) => { element.inert = wasInert; });
          isolated.clear();
          returnFocus?.focus();
        }
      }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }

    const feedback = document.createElement('div');
    feedback.className = 'engineering-copy-feedback';
    feedback.setAttribute('role', 'status');
    document.body.append(feedback);
    let feedbackTimer;
    const notify = message => {
      feedback.textContent = message;
      clearTimeout(feedbackTimer);
      feedbackTimer = setTimeout(() => { feedback.textContent = ''; }, 2500);
    };
    document.querySelectorAll('.main-inner.post .post-body h2 > .headerlink, .main-inner.post .post-body h3 > .headerlink').forEach(anchor => {
      const heading = anchor.parentElement;
      anchor.setAttribute('aria-label', `复制章节链接：${heading.textContent}`);
      anchor.textContent = '#';
      anchor.addEventListener('click', async event => {
        window.anime?.remove(document.scrollingElement);
        if (!navigator.clipboard?.writeText) {
          notify('无法自动复制，可从地址栏复制章节链接。');
          return;
        }
        event.preventDefault();
        const url = new URL(location.href);
        url.search = '';
        url.hash = anchor.hash;
        try {
          await navigator.clipboard.writeText(url.href);
          notify('章节链接已复制。');
        } catch {
          location.hash = anchor.hash;
          notify('无法自动复制，可从地址栏复制章节链接。');
        }
      });
    });

    // Override NexT's unadjusted TOC scrolling without changing theme source.
    document.addEventListener('click', event => {
      const link = event.target.closest('.post-toc a.nav-link');
      if (!link) return;
      const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
      if (!target) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      window.anime?.remove(document.scrollingElement);
      window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - headingOffset(), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      history.pushState(null, '', link.href);
    }, true);
  };
  document.addEventListener('DOMContentLoaded', initializeKnowledgeNavigation);

  const header = document.querySelector('.column');
  const updateHeader = () => header?.classList.toggle('is-scrolled', window.scrollY > 12);

  updateHeader();
  window.addEventListener('scroll', updateHeader, { passive: true });

  const items = document.querySelectorAll('.reveal');
  if (!items.length) return;

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
    items.forEach(item => item.classList.add('is-visible'));
    return;
  }

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

  items.forEach(item => observer.observe(item));
})();
