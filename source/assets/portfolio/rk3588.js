(() => {
  const initialize = () => document.querySelectorAll('.rk3588-showcase').forEach(showcase => {
    const benchmark = showcase.querySelector('.rk-benchmark');
    if (benchmark) {
      const controls = benchmark.querySelector('[data-benchmark-controls]');
      const buttons = [...benchmark.querySelectorAll('[data-benchmark-select]')];
      const rows = [...benchmark.querySelectorAll('[data-benchmark-id]')];
      const status = benchmark.querySelector('[data-benchmark-status]');
      buttons.forEach(button => button.addEventListener('click', () => {
        const selected = button.dataset.benchmarkSelect;
        buttons.forEach(item => {
          const active = item === button;
          item.classList.toggle('is-selected', active);
          item.setAttribute('aria-pressed', String(active));
        });
        rows.forEach(row => row.classList.toggle('is-selected', row.dataset.benchmarkId === selected));
        if (status) status.textContent = `已高亮 ${button.textContent.trim()}，完整比较数据保持显示。`;
      }));
      if (controls && buttons.length) controls.hidden = false;
    }

    const scheduling = showcase.querySelector('.rk-scheduling');
    if (!scheduling) return;
    const controls = scheduling.querySelector('.rk-schedule-controls');
    const frames = [...scheduling.querySelectorAll('[data-schedule-frame]')].sort((a, b) => Number(a.dataset.scheduleFrame) - Number(b.dataset.scheduleFrame));
    const status = scheduling.querySelector('.rk-schedule-status');
    const scrollArea = scheduling.querySelector('.rk-schedule-scroll');
    const play = controls?.querySelector('[data-schedule-action="play"]');
    const pause = controls?.querySelector('[data-schedule-action="pause"]');
    if (!controls || !frames.length || !play || !pause || !status) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let current = -1;
    let timer = null;
    const update = () => {
      frames.forEach((frame, index) => {
        frame.classList.toggle('is-active', index === current);
        frame.classList.toggle('is-complete', current >= 0 && index < current);
      });
      play.disabled = reduceMotion.matches || timer !== null;
      pause.disabled = timer === null;
      if (current < 0) {
        status.textContent = reduceMotion.matches ? '已启用减少动态效果：使用单步查看。静态图保留全部帧与阶段。' : '静态原理图：所有帧与阶段均已展开，横轴不表示实测耗时。';
      } else {
        const label = `F${String(current + 1).padStart(3, '0')}`;
        status.textContent = `${timer === null ? '已暂停' : '播放中'}：${label} / Worker${current % 3}。原理示意，非实测轨迹。`;
      }
    };
    const stop = () => { clearInterval(timer); timer = null; update(); };
    const step = () => {
      current = (current + 1) % frames.length;
      update();
      // Keep the selected frame visible inside the narrow-screen chart only.
      if (scrollArea) {
        const frame = frames[current].getBoundingClientRect();
        const viewport = scrollArea.getBoundingClientRect();
        if (frame.right > viewport.right - 12) scrollArea.scrollLeft += frame.right - viewport.right + 12;
        else if (frame.left < viewport.left + 12) scrollArea.scrollLeft -= viewport.left - frame.left + 12;
      }
    };
    controls.addEventListener('click', event => {
      const action = event.target.closest('[data-schedule-action]')?.dataset.scheduleAction;
      if (action === 'play' && !reduceMotion.matches && timer === null) {
        step();
        timer = setInterval(step, 650);
        update();
      } else if (action === 'pause') {
        stop();
      } else if (action === 'step') {
        stop(); step();
      } else if (action === 'reset') {
        stop(); current = -1; update();
        if (scrollArea) scrollArea.scrollLeft = 0;
      }
    });
    reduceMotion.addEventListener('change', () => { if (reduceMotion.matches) stop(); else update(); });
    if ('IntersectionObserver' in window) new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting && timer !== null) stop();
    }).observe(scheduling);
    document.addEventListener('visibilitychange', () => { if (document.hidden && timer !== null) stop(); });
    window.addEventListener('pagehide', stop);
    controls.hidden = false;
    update();
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize);
  else initialize();
})();
