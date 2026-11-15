(() => {
  const initializeShowcase = root => {
    const rail = root.querySelector('.showcase-rail');
    const tabs = [...root.querySelectorAll('.showcase-tab')];
    const panels = tabs.map(tab => {
      const id = tab.getAttribute('aria-controls');
      return id ? root.querySelector(`#${CSS.escape(id)}`) : null;
    });
    if (!rail || !tabs.length || panels.some(panel => !panel)) return;

    const previous = root.querySelector('.showcase-prev');
    const next = root.querySelector('.showcase-next');
    const status = root.querySelector('.showcase-status');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const coverPreparation = new WeakMap();
    let selectedIndex = 0;
    let scrollTarget = null;
    let lastSelectionAt = -Infinity;
    let resizing = false;
    let scrollTimer;
    let resizeTimer;
    let entranceTimer;
    let pointer = null;
    let suppressClickUntil = 0;

    const wrap = index => (index % tabs.length + tabs.length) % tabs.length;
    const railInset = () => parseFloat(getComputedStyle(rail).paddingLeft) || 0;
    const finishEntrance = () => {
      clearTimeout(entranceTimer);
      panels.forEach(panel => panel.classList.remove('is-entering'));
    };

    const announce = () => {
      if (!status) return;
      const title = tabs[selectedIndex].querySelector('.showcase-tab-title')?.textContent.trim();
      status.textContent = `${String(selectedIndex + 1).padStart(2, '0')} / ${String(tabs.length).padStart(2, '0')}${title ? ` · ${title}` : ''}`;
    };

    const synchronize = index => {
      selectedIndex = index;
      tabs.forEach((tab, tabIndex) => {
        const selected = tabIndex === index;
        tab.setAttribute('aria-selected', String(selected));
        tab.classList.toggle('is-active', selected);
        tab.tabIndex = selected ? 0 : -1;
        panels[tabIndex].hidden = !selected;
        panels[tabIndex].classList.toggle('is-active', selected);
      });
      root.dataset.activeProject = tabs[index].dataset.project;
      announce();
    };

    const finishScroll = () => {
      clearTimeout(scrollTimer);
      if (pointer?.dragging || resizing) return;
      // A requested alignment must not be mistaken for a new swipe selection.
      if (scrollTarget !== null) {
        // A cancelled earlier smooth scroll can also emit scrollend. Keep the
        // latest target until it arrives, or a real pointer gesture takes over.
        if (Math.abs(rail.scrollLeft - scrollTarget) < 1) scrollTarget = null;
        return;
      }
      // When every card fits, the leftmost card does not imply a new selection.
      if (!rail.getClientRects().length || rail.scrollWidth <= rail.clientWidth + 1) return;
      const left = rail.getBoundingClientRect().left + rail.clientLeft + railInset();
      const nearest = tabs.reduce((best, tab, index) => (
        Math.abs(tab.getBoundingClientRect().left - left) < Math.abs(tabs[best].getBoundingClientRect().left - left) ? index : best
      ), 0);
      if (nearest !== selectedIndex) select(nearest, { align: false });
    };

    const scheduleScrollEnd = () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(finishScroll, 160);
    };

    const alignSelected = smooth => {
      const left = rail.scrollLeft + tabs[selectedIndex].getBoundingClientRect().left
        - rail.getBoundingClientRect().left - rail.clientLeft - railInset();
      const target = Math.max(0, Math.min(left, rail.scrollWidth - rail.clientWidth));
      scrollTarget = target;
      rail.scrollTo({ left: target, behavior: smooth && !reducedMotion.matches ? 'smooth' : 'instant' });
      scheduleScrollEnd();
    };

    const prepareCover = (panel, priority = 'low') => {
      const image = panel.querySelector('.showcase-cover-image, .showcase-cover img, img');
      if (!image) return;
      image.fetchPriority = priority;
      image.loading = 'eager';
      const source = image.currentSrc || image.src;
      const cached = coverPreparation.get(image);
      if (cached?.pending || (cached?.ready && cached.source === source)) return;
      const preparation = { source, pending: true, ready: false };
      coverPreparation.set(image, preparation);
      Promise.resolve().then(() => image.decode?.()).then(() => {
        preparation.ready = image.complete && image.naturalWidth > 0;
      }).catch(() => {
        // Loading never blocks selection; the thumbnail remains underneath.
      }).finally(() => {
        preparation.pending = false;
        preparation.source = image.currentSrc || image.src;
      });
    };

    const select = (index, { focus = false, align = true, animate = true } = {}) => {
      index = wrap(index);
      if (focus) tabs[index].focus({ preventScroll: true });
      if (index === selectedIndex) {
        if (align) alignSelected(animate);
        return;
      }
      const now = performance.now();
      const rapid = now - lastSelectionAt < 300;
      lastSelectionAt = now;
      finishEntrance();
      synchronize(index);
      if (animate && !rapid && !reducedMotion.matches) {
        panels[index].classList.add('is-entering');
        entranceTimer = setTimeout(finishEntrance, 320);
      }
      if (align) alignSelected(animate && !rapid);
      prepareCover(panels[index], 'high');
    };

    tabs.forEach((tab, index) => {
      tab.querySelectorAll('img').forEach(image => { image.draggable = false; });
      tab.addEventListener('click', event => {
        event.preventDefault();
        select(index);
      });
      tab.addEventListener('keydown', event => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        let target;
        if (event.key === 'ArrowLeft') target = index - 1;
        else if (event.key === 'ArrowRight') target = index + 1;
        else if (event.key === 'Home') target = 0;
        else if (event.key === 'End') target = tabs.length - 1;
        else return;
        event.preventDefault();
        select(target, { focus: true });
      });
    });
    previous?.addEventListener('click', () => select(selectedIndex - 1));
    next?.addEventListener('click', () => select(selectedIndex + 1));

    rail.addEventListener('scroll', scheduleScrollEnd, { passive: true });
    rail.addEventListener('scrollend', finishScroll);
    rail.addEventListener('dragstart', event => event.preventDefault());
    rail.addEventListener('click', event => {
      if (event.detail > 0 && performance.now() < suppressClickUntil) {
        suppressClickUntil = 0;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    rail.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      scrollTarget = null;
      if (event.pointerType !== 'mouse') return;
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, scroll: rail.scrollLeft, dragging: false };
    });
    rail.addEventListener('pointermove', event => {
      if (!pointer || pointer.id !== event.pointerId) return;
      const distance = event.clientX - pointer.x;
      if (!pointer.dragging && Math.abs(distance) > 8 && Math.abs(distance) >= Math.abs(event.clientY - pointer.y)) {
        pointer.dragging = true;
        rail.classList.add('is-dragging');
        rail.setPointerCapture(event.pointerId);
      }
      if (!pointer.dragging) return;
      event.preventDefault();
      rail.scrollLeft = pointer.scroll - distance;
    });
    const releasePointer = event => {
      if (!pointer || pointer.id !== event.pointerId) return;
      const dragged = pointer.dragging;
      pointer = null;
      rail.classList.remove('is-dragging');
      if (rail.hasPointerCapture(event.pointerId)) rail.releasePointerCapture(event.pointerId);
      if (dragged) {
        suppressClickUntil = performance.now() + 350;
        scheduleScrollEnd();
      }
    };
    window.addEventListener('pointerup', releasePointer);
    window.addEventListener('pointercancel', releasePointer);

    window.addEventListener('resize', () => {
      resizing = true;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizing = false;
        alignSelected(false);
      }, 100);
    });
    reducedMotion.addEventListener('change', () => {
      finishEntrance();
      alignSelected(false);
    });
    window.addEventListener('pageshow', event => {
      if (!event.persisted) return;
      finishEntrance();
      synchronize(0);
      alignSelected(false);
    });

    rail.hidden = false;
    root.querySelectorAll('.showcase-controls').forEach(controls => { controls.hidden = false; });
    synchronize(0);
    alignSelected(false);
    root.classList.add('is-ready');

    panels.forEach((panel, index) => {
      const picture = panel.querySelector('.showcase-cover');
      const image = panel.querySelector('.showcase-cover-image');
      const thumbnail = tabs[index].querySelector('img');
      if (!picture || !image || !thumbnail) return;
      // Reuse the small card image while its larger responsive source loads.
      // The native image paints over this same-aspect preview when it is ready.
      thumbnail.loading = 'eager';
      picture.style.backgroundImage = `url(${JSON.stringify(thumbnail.src)})`;
      image.addEventListener('error', () => image.classList.add('has-cover-error'));
      image.addEventListener('load', () => image.classList.remove('has-cover-error'));
      if (image.complete && !image.naturalWidth) image.classList.add('has-cover-error');
    });
    const warmCovers = () => panels.forEach((panel, index) => prepareCover(panel, index === selectedIndex ? 'high' : 'low'));
    if ('requestIdleCallback' in window) window.requestIdleCallback(warmCovers, { timeout: 1200 });
    else setTimeout(warmCovers, 100);
  };

  const initialize = () => {
    if (!document.querySelector('.home-showcase')) return;
    const search = document.querySelector('.menu-item-search .popup-trigger');
    if (search) {
      search.setAttribute('aria-label', '搜索文章（⌘K / Ctrl+K）');
      search.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg>';
    }
    document.querySelectorAll('.home-showcase').forEach(initializeShowcase);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
