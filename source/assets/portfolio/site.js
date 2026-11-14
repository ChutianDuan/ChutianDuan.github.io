(() => {
  const initializeKnowledgeNavigation = () => {
    const headingOffset = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-height')) + 18;
    const menuToggle = document.querySelector('.site-nav-toggle .toggle');
    const siteNav = document.querySelector('.site-nav');
    let updateMenu = () => {};
    if (menuToggle && siteNav) {
      siteNav.id = siteNav.id || 'engineering-site-nav';
      menuToggle.tabIndex = 0;
      menuToggle.setAttribute('aria-controls', siteNav.id);
      updateMenu = () => {
        const expanded = document.body.classList.contains('site-nav-on');
        menuToggle.setAttribute('aria-expanded', String(expanded));
        menuToggle.setAttribute('aria-label', expanded ? '收起导航' : '展开导航');
        if (expanded) siteNav.style.setProperty('--scroll-height', `${siteNav.scrollHeight}px`);
        // NexT hides the menu visually; also keep its links out of the Tab order.
        siteNav.inert = document.body.classList.contains('search-active') || (window.matchMedia('(max-width: 767px)').matches && !expanded);
      };
      menuToggle.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          menuToggle.click();
        }
      });
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !document.body.classList.contains('search-active') && document.body.classList.contains('site-nav-on')) {
          event.preventDefault();
          menuToggle.click();
          menuToggle.focus();
        }
      });
      new MutationObserver(updateMenu).observe(document.body, { attributes: true, attributeFilter: ['class'] });
      window.addEventListener('resize', updateMenu);
      updateMenu();
    }
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
      const restoreSearchFocus = () => {
        const available = element => element?.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' && !element.closest('[inert]');
        const target = available(returnFocus) && returnFocus !== document.body
          ? returnFocus
          : [...document.querySelectorAll('.popup-trigger')].find(available);
        target?.focus();
      };
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
      popup.addEventListener('keydown', event => {
        if (event.isComposing || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
        if (document.activeElement !== input && !results.contains(document.activeElement)) return;
        const links = [...results.querySelectorAll('.search-result-title')];
        if (!links.length) return;
        const current = links.indexOf(document.activeElement);
        const next = event.key === 'ArrowDown' ? current + 1 : current < 0 ? links.length - 1 : current - 1;
        event.preventDefault();
        if (next < 0 || next >= links.length) {
          input.focus();
        } else {
          links[next].focus({ preventScroll: true });
          links[next].scrollIntoView({ block: 'nearest' });
        }
      });
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
        if (!active && popup.contains(event.target)) restoreSearchFocus();
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
          // A resize while searching may have changed the menu's visibility.
          updateMenu();
          restoreSearchFocus();
          // Media-query visibility can settle on the next frame after a resize.
          requestAnimationFrame(() => requestAnimationFrame(() => {
            if (!active && (document.activeElement === document.body || popup.contains(document.activeElement))) restoreSearchFocus();
          }));
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
    document.querySelectorAll('.main-inner.post figure.highlight').forEach((figure, index) => {
      const container = figure.querySelector('.code-container');
      const table = figure.querySelector('.table-container');
      const code = figure.querySelector('.code pre, pre code');
      if (!container || !table || !code) return;
      const lines = [...code.querySelectorAll('.line')];
      // textContent includes clipped lines and excludes the separate line-number gutter.
      const fullCode = lines.length ? lines.map(line => line.textContent).join('\n') : code.textContent;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'copy-btn';
      copy.textContent = '复制';
      copy.setAttribute('aria-label', '复制完整代码');
      const originalCopy = figure.querySelector('.copy-btn');
      if (originalCopy) originalCopy.replaceWith(copy);
      else container.append(copy);
      let copyTimer;
      copy.addEventListener('click', async () => {
        try {
          if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
          await navigator.clipboard.writeText(fullCode);
          copy.textContent = '已复制';
          notify('完整代码已复制。');
        } catch {
          copy.textContent = '复制失败';
          notify('无法自动复制，请选择代码手动复制。');
        }
        clearTimeout(copyTimer);
        copyTimer = setTimeout(() => { copy.textContent = '复制'; }, 2500);
      });
      if ((lines.length || fullCode.split('\n').length) <= 40) return;
      table.id = `engineering-code-${index + 1}`;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'engineering-code-toggle';
      toggle.textContent = '收起';
      toggle.setAttribute('aria-controls', table.id);
      toggle.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('aria-label', '收起代码，保留前 12 行');
      toggle.addEventListener('click', () => {
        const collapsed = figure.classList.toggle('engineering-code-collapsed');
        // Always show the first twelve lines when collapsing a scrolled code block.
        table.scrollTop = 0;
        toggle.textContent = collapsed ? '展开' : '收起';
        toggle.setAttribute('aria-expanded', String(!collapsed));
        toggle.setAttribute('aria-label', collapsed ? '展开完整代码' : '收起代码，保留前 12 行');
      });
      container.append(toggle);
    });
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
      const link = event.target.closest('.post-toc a.nav-link, .engineering-mobile-toc a');
      if (!link) return;
      const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
      if (!target) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      window.anime?.remove(document.scrollingElement);
      // Collapse the inline TOC before measuring the destination's final position.
      const mobileToc = link.closest('.engineering-mobile-toc');
      if (mobileToc) {
        mobileToc.open = false;
        target.tabIndex = -1;
        target.focus({ preventScroll: true });
      }
      window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - headingOffset(), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      history.pushState(null, '', link.href);
    }, true);
  };
  document.addEventListener('DOMContentLoaded', initializeKnowledgeNavigation);

  const header = document.querySelector('.column');
  const updateHeader = () => header?.classList.toggle('is-scrolled', window.scrollY > 12);

  updateHeader();
  window.addEventListener('scroll', updateHeader, { passive: true });

})();
