const DEFAULT_ROW_HEIGHT = 72;
const DEFAULT_BUFFER = 12;
const MAX_DOM_ROWS = 100;

export class ClientVirtualList {
  constructor(options = {}) {
    this.viewport = typeof options.viewport === "string"
      ? document.getElementById(options.viewport)
      : options.viewport;
    this.spacer = typeof options.spacer === "string"
      ? document.getElementById(options.spacer)
      : options.spacer;
    this.rows = typeof options.rows === "string"
      ? document.getElementById(options.rows)
      : options.rows;
    if (!this.viewport || !this.spacer || !this.rows) {
      throw new Error("仮想リストに必要な要素が見つかりません。");
    }
    this.rowHeight = Math.max(40, Number(options.rowHeight) || DEFAULT_ROW_HEIGHT);
    this.buffer = Math.max(2, Number(options.buffer) || DEFAULT_BUFFER);
    this.renderRow = options.renderRow;
    this.items = [];
    this.revision = 0;
    this.frame = 0;
    this.lastRange = { start: 0, end: 0 };
    this.onScroll = () => this.scheduleRender();
    this.viewport.addEventListener("scroll", this.onScroll, { passive: true });
    if ("ResizeObserver" in window) {
      this.resizeObserver = new ResizeObserver(() => this.scheduleRender(true));
      this.resizeObserver.observe(this.viewport);
    }
  }

  setItems(items, options = {}) {
    this.items = Array.isArray(items) ? items : [];
    this.revision += 1;
    if (!options.preserveScroll) {
      this.viewport.scrollTop = 0;
    }
    this.spacer.style.height = `${this.items.length * this.rowHeight}px`;
    this.viewport.setAttribute("aria-rowcount", String(this.items.length));
    this.scheduleRender(true);
  }

  calculateRange() {
    const count = this.items.length;
    if (!count) {
      return { start: 0, end: 0 };
    }
    const visible = Math.max(1, Math.ceil(this.viewport.clientHeight / this.rowHeight));
    const firstVisible = Math.max(
      0,
      Math.min(count - 1, Math.floor(this.viewport.scrollTop / this.rowHeight)),
    );
    let start = Math.max(0, firstVisible - this.buffer);
    let end = Math.min(count, firstVisible + visible + this.buffer);
    if (end - start > MAX_DOM_ROWS) {
      end = Math.min(count, start + MAX_DOM_ROWS);
      start = Math.max(0, end - MAX_DOM_ROWS);
    }
    return { start, end };
  }

  scheduleRender(force = false) {
    if (force && this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    if (this.frame) {
      return;
    }
    const revision = this.revision;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (revision === this.revision) {
        this.render();
      }
    });
  }

  render() {
    const range = this.calculateRange();
    this.lastRange = range;
    const fragment = document.createDocumentFragment();
    for (let index = range.start; index < range.end; index += 1) {
      const row = this.renderRow(this.items[index], index);
      row.classList.add("virtual-card-row");
      row.style.top = `${index * this.rowHeight}px`;
      row.style.height = `${this.rowHeight}px`;
      row.setAttribute("aria-rowindex", String(index + 1));
      fragment.appendChild(row);
    }
    this.rows.replaceChildren(fragment);
  }

  getVisibleItems() {
    return this.items.slice(this.lastRange.start, this.lastRange.end);
  }

  getState() {
    return {
      totalCount: this.items.length,
      renderedRows: this.rows.children.length,
      ...this.lastRange,
    };
  }

  destroy() {
    this.viewport.removeEventListener("scroll", this.onScroll);
    this.resizeObserver?.disconnect();
    if (this.frame) {
      cancelAnimationFrame(this.frame);
    }
    this.rows.replaceChildren();
  }
}

export const CLIENT_VIRTUAL_LIMITS = Object.freeze({
  DEFAULT_ROW_HEIGHT,
  DEFAULT_BUFFER,
  MAX_DOM_ROWS,
});
