const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function initReveals() {
  const elements = document.querySelectorAll<HTMLElement>('.reveal');
  if (reduceMotion.matches || !('IntersectionObserver' in window)) {
    elements.forEach((element) => element.classList.add('is-visible'));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });

  document.documentElement.classList.add('has-motion');
  elements.forEach((element) => observer.observe(element));
}

function initDepth() {
  const layer = document.querySelector<HTMLElement>('[data-depth]');
  if (!layer || reduceMotion.matches) return;
  let frame = 0;

  const update = () => {
    frame = 0;
    const progress = Math.min(1, window.scrollY / Math.max(window.innerHeight, 1));
    layer.style.setProperty('--depth-shift', `${progress * 18}px`);
  };
  const requestUpdate = () => {
    if (!frame) frame = window.requestAnimationFrame(update);
  };
  const toggle = () => {
    window.removeEventListener('scroll', requestUpdate);
    if (!document.hidden && !reduceMotion.matches) window.addEventListener('scroll', requestUpdate, { passive: true });
  };
  document.addEventListener('visibilitychange', toggle);
  reduceMotion.addEventListener('change', (event) => {
    if (!event.matches) return;
    if (frame) window.cancelAnimationFrame(frame);
    window.removeEventListener('scroll', requestUpdate);
    layer.style.removeProperty('--depth-shift');
    document.documentElement.classList.remove('has-motion');
    document.querySelectorAll<HTMLElement>('.reveal').forEach((element) => element.classList.add('is-visible'));
  }, { once: true });
  toggle();
}

function initCountdown() {
  const countdown = document.querySelector<HTMLElement>('[data-countdown]');
  if (!countdown) return;
  const target = new Date(countdown.dataset.target ?? '').getTime();
  const numbers = countdown.querySelector<HTMLElement>('[data-countdown-numbers]');
  const begun = countdown.querySelector<HTMLElement>('[data-countdown-begun]');
  let timer: number | undefined;

  const render = () => {
    if (timer) window.clearTimeout(timer);
    const remaining = target - Date.now();
    if (remaining <= 0) {
      if (numbers) numbers.hidden = true;
      if (begun) begun.hidden = false;
      return;
    }
    const totalMinutes = Math.floor(remaining / 60_000);
    const days = Math.floor(totalMinutes / 1_440);
    const hours = Math.floor((totalMinutes % 1_440) / 60);
    const minutes = totalMinutes % 60;
    const set = (selector: string, value: number) => {
      const node = countdown.querySelector<HTMLElement>(selector);
      if (node) node.textContent = String(value).padStart(2, '0');
    };
    set('[data-days]', days);
    set('[data-hours]', hours);
    set('[data-minutes]', minutes);
    const untilNextMinute = 60_000 - (Date.now() % 60_000) + 20;
    timer = window.setTimeout(render, Math.min(remaining, untilNextMinute));
  };

  const toggle = () => {
    if (timer) window.clearTimeout(timer);
    if (!document.hidden) render();
  };
  document.addEventListener('visibilitychange', toggle);
  toggle();
}

function initCopy() {
  document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      const value = button.dataset.copy ?? '';
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value);
        } else {
          throw new Error('Clipboard API is unavailable');
        }
        const label = button.querySelector<HTMLElement>('[data-copy-label]');
        if (label) label.textContent = 'Location copied';
      } catch {
        window.prompt('Copy this location, then paste it into your maps app:', value);
      }
    });
  });
}

initReveals();
initDepth();
initCountdown();
initCopy();
