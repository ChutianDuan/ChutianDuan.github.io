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
    let selectedIndex = 0;
    let requestedIndex = 0;
    let requestVersion = 0;
    let programmaticScroll = false;
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
      requestedIndex = index;
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
      if (programmaticScroll) {
        programmaticScroll = false;
        return;
      }
      // When every card fits, the leftmost card does not imply a new selection.
      if (!rail.getClientRects().length || rail.scrollWidth <= rail.clientWidth + 1) return;
      const left = rail.getBoundingClientRect().left + rail.clientLeft + railInset();
      const nearest = tabs.reduce((best, tab, index) => (
        Math.abs(tab.getBoundingClientRect().left - left) < Math.abs(tabs[best].getBoundingClientRect().left - left) ? index : best
      ), 0);
      if (nearest !== requestedIndex) select(nearest, { align: false });
    };

    const scheduleScrollEnd = () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(finishScroll, 160);
    };

    const alignSelected = smooth => {
      const left = rail.scrollLeft + tabs[selectedIndex].getBoundingClientRect().left
        - rail.getBoundingClientRect().left - rail.clientLeft - railInset();
      const target = Math.max(0, Math.min(left, rail.scrollWidth - rail.clientWidth));
      programmaticScroll = true;
      rail.scrollTo({ left: target, behavior: smooth && !reducedMotion.matches ? 'smooth' : 'instant' });
      scheduleScrollEnd();
    };

    const decodeCover = async panel => {
      const image = panel.querySelector('.showcase-cover-image, .showcase-cover img, img');
      if (!image) return;
      // Hidden lazy images need an explicit request before their panel is revealed.
      image.loading = 'eager';
      try {
        if (typeof image.decode === 'function') {
          await image.decode();
        } else if (!image.complete) {
          await new Promise(resolve => {
            const settle = () => {
              image.removeEventListener('load', settle);
              image.removeEventListener('error', settle);
              resolve();
            };
            image.addEventListener('load', settle);
            image.addEventListener('error', settle);
          });
        }
      } catch {
        // A missing cover keeps its useful alt text; the project remains reachable.
      }
    };

    const select = async (index, { focus = false, align = true, animate = true } = {}) => {
      index = wrap(index);
      const version = ++requestVersion;
      requestedIndex = index;
      if (focus) tabs[index].focus({ preventScroll: true });
      if (index !== selectedIndex) await decodeCover(panels[index]);
      // Cover decoding may finish in a different order from rapid user requests.
      if (version !== requestVersion) return;
      const changed = index !== selectedIndex;
      finishEntrance();
      synchronize(index);
      if (changed && animate && !reducedMotion.matches) {
        panels[index].classList.add('is-entering');
        entranceTimer = setTimeout(finishEntrance, 320);
      }
      if (align) alignSelected(animate);
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
    previous?.addEventListener('click', () => select(requestedIndex - 1));
    next?.addEventListener('click', () => select(requestedIndex + 1));

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
      ++requestVersion;
      requestedIndex = selectedIndex;
      programmaticScroll = false;
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
      ++requestVersion;
      finishEntrance();
      synchronize(0);
      alignSelected(false);
    });

    rail.hidden = false;
    root.querySelectorAll('.showcase-controls').forEach(controls => { controls.hidden = false; });
    synchronize(0);
    alignSelected(false);
    root.classList.add('is-ready');
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
