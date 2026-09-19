/**
 * DOM bridge only. Three.js, context creation and rendering stay in a module worker.
 * A failed/unsupported renderer leaves the static SVG in place.
 */
export function initElloraScene(host: HTMLElement): () => void {
  if (!('transferControlToOffscreen' in HTMLCanvasElement.prototype) || !('Worker' in window)) {
    host.dataset.sceneState = 'fallback';
    return () => undefined;
  }
  const canvas = document.createElement('canvas');
  canvas.className = 'ellora-scene__canvas';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.dataset.frame = '0';
  canvas.dataset.engine = 'three.js r186 · worker';
  host.append(canvas);
  let worker: Worker | undefined;
  try {
    worker = new Worker(new URL('./ellora-worker.ts', import.meta.url), { type: 'module' });
    const offscreen = canvas.transferControlToOffscreen();
    worker.postMessage({ type: 'init', canvas: offscreen, view: view() }, [offscreen]);
  } catch {
    worker?.terminate();
    canvas.remove();
    host.dataset.sceneState = 'fallback';
    return () => undefined;
  }

  let disposed = false;
  let visible = true;
  let pending = 0;
  const startupTimeout = window.setTimeout(dispose, 15000);
  function view() {
    const rect = host.getBoundingClientRect();
    return {
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
      dpr: Math.min(window.devicePixelRatio || 1, rect.width < 768 ? 1.5 : 1.75),
      progress: Math.max(0, Math.min(1, -rect.top / Math.max(rect.height * .82, 1))),
      active: !document.hidden && rect.bottom > 0 && rect.top < window.innerHeight,
    };
  }
  function sendView() {
    pending = 0;
    if (!disposed) worker?.postMessage({ type: 'view', view: view() });
  }
  function requestView() {
    if (!disposed && visible && !document.hidden && !pending) pending = requestAnimationFrame(sendView);
  }
  const intersection = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    sendView();
  });
  intersection.observe(host);
  const resize = new ResizeObserver(requestView);
  resize.observe(host);
  const lost = (event: Event) => { event.preventDefault(); dispose(); };
  canvas.addEventListener('webglcontextlost', lost);
  window.addEventListener('scroll', requestView, { passive: true });
  window.addEventListener('resize', requestView, { passive: true });
  document.addEventListener('visibilitychange', sendView);
  worker.onmessage = (event: MessageEvent<{ type: string; frame: number; calls: number; triangles: number }>) => {
    if (disposed) return;
    if (event.data.type === 'fallback') { dispose(); return; }
    if (event.data.type === 'frame') {
      clearTimeout(startupTimeout);
      host.dataset.sceneState = 'ready';
      canvas.dataset.frame = String(event.data.frame);
      canvas.dataset.drawCalls = String(event.data.calls);
      canvas.dataset.triangles = String(event.data.triangles);
    }
  };
  worker.onerror = (event) => { event.preventDefault(); dispose(); };
  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(startupTimeout);
    if (pending) cancelAnimationFrame(pending);
    intersection.disconnect();
    resize.disconnect();
    window.removeEventListener('scroll', requestView);
    window.removeEventListener('resize', requestView);
    document.removeEventListener('visibilitychange', sendView);
    canvas.removeEventListener('webglcontextlost', lost);
    worker?.postMessage({ type: 'dispose' });
    // Let the worker release GPU resources before terminating a stuck worker.
    window.setTimeout(() => worker?.terminate(), 200);
    canvas.remove();
    host.dataset.sceneState = 'fallback';
  }
  return dispose;
}
