/**
 * Timeline chart (canvas, dependency free).
 *
 * The chart is a visual summary of locally computed buckets. It is redrawn on
 * resize and on theme change so light and dark modes each get readable colours.
 * Values are always accompanied by text in the page (accessibility), and the
 * canvas itself carries an aria-label.
 */
export class TimelineChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.wrap = canvas.closest('.chart-wrap') ?? canvas.parentElement;
    this.data = {buckets: [], stepMs: 60000, durationMs: 0};
    this.tooltipBuilder = null;
    this.tooltip = null;
    this.hoverIndex = -1;

    this.handleResize = () => this.draw();
    this.resizeObserver = new ResizeObserver(this.handleResize);
    this.resizeObserver.observe(canvas);
    window.addEventListener('livememory:themechange', this.handleResize);

    this.handleMove = (event) => this.onMove(event);
    this.handleLeave = () => this.hideTooltip();
    canvas.addEventListener('mousemove', this.handleMove);
    canvas.addEventListener('mouseleave', this.handleLeave);
  }

  setData(timeline, {tooltipBuilder = null, ariaLabel = null} = {}) {
    this.data = {
      buckets: Array.isArray(timeline?.buckets) ? timeline.buckets : [],
      stepMs: Number(timeline?.stepMs ?? 60000),
      durationMs: Number(timeline?.durationMs ?? 0)
    };
    this.tooltipBuilder = tooltipBuilder;
    if (ariaLabel) this.canvas.setAttribute('aria-label', ariaLabel);
    this.hoverIndex = -1;
    this.hideTooltip();
    this.draw();
  }

  destroy() {
    this.resizeObserver.disconnect();
    window.removeEventListener('livememory:themechange', this.handleResize);
    this.canvas.removeEventListener('mousemove', this.handleMove);
    this.canvas.removeEventListener('mouseleave', this.handleLeave);
    this.tooltip?.remove();
    this.tooltip = null;
  }

  #colors() {
    const styles = getComputedStyle(document.documentElement);
    return {
      line: styles.getPropertyValue('--chart-line').trim() || '#0071e3',
      fillTop: styles.getPropertyValue('--chart-fill-top').trim() || 'rgba(0,113,227,0.22)',
      fillBottom: styles.getPropertyValue('--chart-fill-bottom').trim() || 'rgba(0,113,227,0.02)',
      grid: styles.getPropertyValue('--chart-grid').trim() || 'rgba(0,0,0,0.07)',
      muted: styles.getPropertyValue('--text-tertiary').trim() || '#86868b'
    };
  }

  #geometry() {
    const rect = this.canvas.getBoundingClientRect();
    const padding = {top: 16, right: 12, bottom: 24, left: 12};
    return {
      width: rect.width,
      height: rect.height,
      padding,
      plotWidth: Math.max(0, rect.width - padding.left - padding.right),
      plotHeight: Math.max(0, rect.height - padding.top - padding.bottom)
    };
  }

  draw() {
    const {buckets} = this.data;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    const ctx = this.context;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const colors = this.#colors();
    const {padding, plotWidth, plotHeight} = this.#geometry();
    const baseY = padding.top + plotHeight;

    // Horizontal guides: quiet, hairline, never competing with the data.
    ctx.lineWidth = 1;
    ctx.strokeStyle = colors.grid;
    for (let index = 0; index <= 3; index += 1) {
      const y = Math.round(padding.top + (plotHeight * index) / 3) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + plotWidth, y);
      ctx.stroke();
    }

    if (buckets.length === 0) return;
    const maxValue = Math.max(1, ...buckets.map((bucket) => bucket.messages));
    const stepX = buckets.length > 1 ? plotWidth / (buckets.length - 1) : plotWidth;
    const points = buckets.map((bucket, index) => {
      const x = padding.left + (buckets.length > 1 ? index * stepX : plotWidth / 2);
      const ratio = bucket.messages / maxValue;
      const y = baseY - ratio * plotHeight;
      return {x, y, bucket};
    });

    // Area fill
    const gradient = ctx.createLinearGradient(0, padding.top, 0, baseY);
    gradient.addColorStop(0, colors.fillTop);
    gradient.addColorStop(1, colors.fillBottom);
    ctx.beginPath();
    ctx.moveTo(points[0].x, baseY);
    for (const point of points) ctx.lineTo(point.x, point.y);
    ctx.lineTo(points[points.length - 1].x, baseY);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // Line
    ctx.beginPath();
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = colors.line;
    ctx.stroke();

    // Hover marker
    if (this.hoverIndex >= 0 && points[this.hoverIndex]) {
      const point = points[this.hoverIndex];
      ctx.beginPath();
      ctx.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = colors.line;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(point.x, point.y, 6.5, 0, Math.PI * 2);
      ctx.strokeStyle = colors.line;
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Time labels: first, middle, last bucket start.
    ctx.fillStyle = colors.muted;
    ctx.font = '10.5px ' + (getComputedStyle(document.body).fontFamily || 'sans-serif');
    ctx.textBaseline = 'top';
    if (this.labelForBucket) {
      const labelIndexes = buckets.length > 2 ? [0, Math.floor((buckets.length - 1) / 2), buckets.length - 1] : [0, buckets.length - 1];
      for (const index of labelIndexes) {
        const point = points[index];
        if (!point) continue;
        const label = this.labelForBucket(point.bucket.startAt);
        const width = ctx.measureText(label).width;
        let x = point.x - width / 2;
        x = Math.max(padding.left, Math.min(x, padding.left + plotWidth - width));
        ctx.fillText(label, x, baseY + 8);
      }
    }
  }

  setLabelFormatter(fn) {
    this.labelForBucket = fn;
  }

  #indexFromEvent(event) {
    const {padding, plotWidth} = this.#geometry();
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left - padding.left;
    const ratio = Math.max(0, Math.min(1, x / Math.max(plotWidth, 1)));
    const count = this.data.buckets.length;
    if (count === 0) return -1;
    return Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1))));
  }

  onMove(event) {
    if (!this.tooltipBuilder || this.data.buckets.length === 0) return;
    const index = this.#indexFromEvent(event);
    if (index < 0) return;
    if (index !== this.hoverIndex) {
      this.hoverIndex = index;
      this.draw();
    }
    if (!this.tooltip) {
      this.tooltip = document.createElement('div');
      this.tooltip.className = 'chart-tooltip';
      this.tooltip.setAttribute('role', 'status');
      this.wrap.append(this.tooltip);
    }
    const bucket = this.data.buckets[index];
    const {padding, plotWidth} = this.#geometry();
    const count = this.data.buckets.length;
    const x = padding.left + (count > 1 ? (plotWidth * index) / (count - 1) : plotWidth / 2);
    this.tooltip.textContent = '';
    const parts = this.tooltipBuilder(bucket);
    parts.forEach((part, partIndex) => {
      if (partIndex > 0) this.tooltip.append(document.createElement('br'));
      this.tooltip.append(document.createTextNode(String(part)));
    });
    this.tooltip.style.left = `${x}px`;
    this.tooltip.style.top = `${padding.top}px`;
    this.tooltip.style.opacity = '1';
  }

  hideTooltip() {
    if (this.tooltip) this.tooltip.style.opacity = '0';
    if (this.hoverIndex !== -1) {
      this.hoverIndex = -1;
      this.draw();
    }
  }
}
