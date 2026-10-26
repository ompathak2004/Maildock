import { useEffect, useRef } from 'react';

type Particle = {
  x: number;
  y: number;
  originX: number;
  originY: number;
  scatterX: number;
  scatterY: number;
  delay: number;
  alpha: number;
};

export function ParticleWordmark({ compact = false }: { compact?: boolean }) {
  const elementRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const element = elementRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    const mask = document.createElement('canvas');
    const maskContext = mask.getContext('2d', { willReadFrequently: true });
    if (!element || !canvas || !context || !maskContext) return;

    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const theme = matchMedia('(prefers-color-scheme: dark)');
    let particles: Particle[] = [];
    let frame = 0;
    let width = 0;
    let height = 0;
    let visible = true;
    let startedAt = performance.now();
    let lastFrame = startedAt;
    let pointer: { x: number; y: number } | null = null;
    let palette: CanvasGradient | null = null;

    function draw(now: number) {
      if (!context) return;
      frame = 0;
      const elapsed = now - startedAt;
      const follow = 1 - 0.78 ** (Math.min(now - lastFrame, 50) / (1000 / 60));
      lastFrame = now;
      let moving = false;
      context.clearRect(0, 0, width, height);
      context.fillStyle = palette ?? '#808080';

      for (const particle of particles) {
        const progress = motion.matches
          ? 1
          : Math.min(1, Math.max(0, (elapsed - particle.delay) / 1100));
        const remaining = (1 - progress) ** 3;
        let x = particle.originX + particle.scatterX * remaining;
        let y = particle.originY + particle.scatterY * remaining;
        if (pointer && !motion.matches) {
          const dx = x - pointer.x;
          const dy = y - pointer.y;
          const distance = Math.hypot(dx, dy);
          if (distance > 0 && distance < 46) {
            const force = (1 - distance / 46) ** 2 * 9;
            x += (dx / distance) * force;
            y += (dy / distance) * force;
          }
        }
        particle.x += (x - particle.x) * (motion.matches ? 1 : follow);
        particle.y += (y - particle.y) * (motion.matches ? 1 : follow);
        const unsettled = Math.abs(x - particle.x) + Math.abs(y - particle.y) > 0.04;
        if (progress < 1 || unsettled) moving = true;
        else {
          particle.x = x;
          particle.y = y;
        }
        context.globalAlpha = particle.alpha * (0.3 + 0.7 * progress);
        context.fillRect(particle.x, particle.y, compact ? 0.9 : 1.35, compact ? 0.9 : 1.35);
      }
      context.globalAlpha = 1;
      if (moving) wake();
    }

    function wake() {
      if (frame || !visible || document.hidden || motion.matches) return;
      frame = requestAnimationFrame(draw);
    }

    function sample() {
      if (!element || !canvas || !context || !maskContext) return;
      const bounds = element.getBoundingClientRect();
      width = Math.floor(bounds.width);
      height = Math.floor(bounds.height);
      if (!width || !height) return;
      const style = getComputedStyle(element);
      const scale = Math.min(devicePixelRatio, 2);
      canvas.width = width * scale;
      canvas.height = height * scale;
      context.setTransform(scale, 0, 0, scale, 0, 0);
      palette = context.createLinearGradient(0, 0, width, height * 0.4);
      palette.addColorStop(0, style.getPropertyValue('--wordmark-edge').trim());
      palette.addColorStop(0.48, style.getPropertyValue('--wordmark-mid').trim());
      palette.addColorStop(1, style.getPropertyValue('--wordmark-edge').trim());
      mask.width = width;
      mask.height = height;
      maskContext.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      maskContext.textAlign = 'center';
      maskContext.textBaseline = 'middle';
      maskContext.fillStyle = '#fff';
      maskContext.fillText('Maildock', width / 2, height / 2);
      const pixels = maskContext.getImageData(0, 0, width, height).data;
      particles = [];
      const step = compact ? 1.3 : 1.8;
      for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
          const alpha = pixels[(Math.floor(y) * width + Math.floor(x)) * 4 + 3] ?? 0;
          if (alpha < 60) continue;
          const seed = ((particles.length * 9301 + 49297) % 233280) / 233280;
          const angle = seed * Math.PI * 2;
          const distance = (compact ? 15 : 48) * (0.4 + seed);
          const scatterX = Math.cos(angle) * distance;
          const scatterY = Math.sin(angle) * distance;
          particles.push({
            x: x + scatterX,
            y: y + scatterY,
            originX: x,
            originY: y,
            scatterX,
            scatterY,
            delay: seed * 180,
            alpha: alpha / 255,
          });
        }
      }
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      element.dataset.ready = 'true';
      draw(performance.now());
    }

    function move(event: PointerEvent) {
      if (!canvas || motion.matches) return;
      const bounds = canvas.getBoundingClientRect();
      pointer = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      wake();
    }

    function leave() {
      pointer = null;
      wake();
    }

    function visibilityChanged() {
      if (document.hidden) {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
      } else wake();
    }

    function motionChanged() {
      pointer = null;
      startedAt = performance.now() - 2000;
      sample();
    }

    const resizeObserver = new ResizeObserver(sample);
    resizeObserver.observe(element);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      if (visible) wake();
      else if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    });
    intersectionObserver.observe(element);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerleave', leave);
    document.addEventListener('visibilitychange', visibilityChanged);
    motion.addEventListener('change', motionChanged);
    theme.addEventListener('change', sample);
    sample();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerleave', leave);
      document.removeEventListener('visibilitychange', visibilityChanged);
      motion.removeEventListener('change', motionChanged);
      theme.removeEventListener('change', sample);
    };
  }, [compact]);

  return (
    <span ref={elementRef} className={`wordmark${compact ? ' wordmark-compact' : ''}`}>
      <span className="wordmark-fallback">Maildock</span>
      <canvas ref={canvasRef} aria-hidden="true" tabIndex={-1} />
    </span>
  );
}
