(() => {
  "use strict";

  const app = window.FolderVisualizer = window.FolderVisualizer || {};
  const Common = app.Common || {};
  const ROW_HEIGHT = Common.TABLE_ROW_HEIGHT || 44;
  const BUFFER_ROWS = Common.TABLE_BUFFER_ROWS || 15;
  const MAX_DOM_ROWS = Common.TABLE_MAX_DOM_ROWS || 100;
  const CHUNK_SIZE = Common.CACHE_CHUNK_SIZE || 500;
  const MAX_CACHE_CHUNKS = 3;
  const TABLE_SIZES = new Set(["small", "medium", "large", "fullscreen"]);

  function resolveElement(value, fallbackId) {
    if (value instanceof Element) {
      return value;
    }
    return document.getElementById(value || fallbackId);
  }

  function normalizeFiles(result) {
    if (Array.isArray(result)) {
      return result;
    }
    return Array.isArray(result?.files) ? result.files : [];
  }

  class VirtualFileTable {
    constructor(options = {}) {
      this.wrapper = resolveElement(options.wrapper, "virtual-table-wrapper");
      this.header = resolveElement(options.header, "virtual-table-header");
      this.viewport = resolveElement(options.viewport, "virtual-table-viewport");
      this.spacer = resolveElement(options.spacer, "virtual-table-spacer");
      this.rows = resolveElement(options.rows, "virtual-table-rows");
      this.empty = resolveElement(options.empty, "virtual-table-empty");
      this.loading = resolveElement(options.loading, "table-loading");
      this.closeButton = resolveElement(options.closeButton, "table-close");
      this.getFilesByIds = options.getFilesByIds
        || app.Storage?.getFilesByIds?.bind(app.Storage);
      this.renderRow = options.renderRow || ((file, index) => this.createFileRow(file, index));
      this.onError = options.onError || ((error) => console.error(
        "ファイル一覧の読み込みに失敗しました。",
        error,
      ));

      if (!this.wrapper || !this.viewport || !this.spacer || !this.rows) {
        throw new Error("仮想テーブルに必要な要素が見つかりません。");
      }
      if (typeof this.getFilesByIds !== "function") {
        throw new Error("ファイル情報の範囲取得機能を利用できません。");
      }

      this.ids = [];
      this.totalCount = 0;
      this.cache = new Map();
      this.inFlight = new Map();
      this.dataRevision = 0;
      this.renderRequestId = 0;
      this.frameId = 0;
      this.lastScrollTop = 0;
      this.lastRange = { start: 0, end: 0 };
      this.size = "medium";
      this.sizeBeforeFullscreen = "medium";
      this.fullscreenTrigger = null;
      this.destroyed = false;
      this.boundListeners = [];

      this.rows.style.position = "absolute";
      this.rows.style.inset = "0";
      this.rows.style.pointerEvents = "none";
      this.spacer.style.position = "relative";
      this.wrapper.setAttribute("role", "grid");
      this.wrapper.setAttribute("aria-colcount", "5");
      document.getElementById("virtual-table-header")?.setAttribute("aria-rowindex", "1");

      this.handleScroll = () => {
        this.syncHeaderScroll();
        this.scheduleRender();
      };
      this.handleEscape = (event) => {
        if (event.key === "Escape" && this.size === "fullscreen") {
          this.exitFullscreen();
        }
      };

      this.viewport.addEventListener("scroll", this.handleScroll, { passive: true });
      document.addEventListener("keydown", this.handleEscape);

      document.querySelectorAll("[data-table-size]").forEach((button) => {
        const handler = () => this.setSize(button.dataset.tableSize, { trigger: button });
        button.addEventListener("click", handler);
        this.boundListeners.push([button, "click", handler]);
      });

      if (this.closeButton) {
        const handler = () => this.exitFullscreen();
        this.closeButton.addEventListener("click", handler);
        this.boundListeners.push([this.closeButton, "click", handler]);
      }

      if ("ResizeObserver" in window) {
        this.resizeObserver = new ResizeObserver(() => {
          this.syncHeaderScroll(true);
          this.scheduleRender(true);
        });
        this.resizeObserver.observe(this.viewport);
      } else {
        this.handleWindowResize = () => this.scheduleRender(true);
        window.addEventListener("resize", this.handleWindowResize);
      }

      this.setSize(options.initialSize || "medium", { render: false });
      this.updateGeometry();
      this.syncHeaderScroll(true);
    }

    setData(ids, options = {}) {
      this.dataRevision += 1;
      this.renderRequestId += 1;
      this.ids = Array.isArray(ids) ? ids.slice() : [];
      this.totalCount = this.ids.length;
      this.cache.clear();
      this.inFlight.clear();
      this.lastRange = { start: 0, end: 0 };
      if (!options.preserveScroll) {
        this.viewport.scrollTop = 0;
        this.lastScrollTop = 0;
      }
      this.updateGeometry();
      return this.renderNow();
    }

    clear() {
      return this.setData([]);
    }

    updateGeometry() {
      this.spacer.style.height = `${this.totalCount * ROW_HEIGHT}px`;
      this.wrapper.setAttribute("aria-rowcount", String(this.totalCount + 1));
      const isEmpty = this.totalCount === 0;
      this.empty?.classList.toggle("hidden", !isEmpty);
      if (isEmpty) {
        this.rows.replaceChildren();
        this.setLoading(false);
      }
      this.syncHeaderScroll(true);
    }

    setSize(size, options = {}) {
      const nextSize = TABLE_SIZES.has(size) ? size : "medium";
      const wasFullscreen = this.size === "fullscreen";
      if (nextSize === "fullscreen" && !wasFullscreen) {
        this.sizeBeforeFullscreen = this.size;
        this.fullscreenTrigger = options.trigger || document.activeElement;
      }
      this.size = nextSize;

      for (const item of TABLE_SIZES) {
        this.wrapper.classList.toggle(`table-size-${item}`, item === nextSize);
      }
      this.wrapper.classList.toggle("is-fullscreen", nextSize === "fullscreen");
      document.body.classList.toggle(
        "virtual-table-fullscreen-open",
        nextSize === "fullscreen",
      );

      document.querySelectorAll("[data-table-size]").forEach((button) => {
        const active = button.dataset.tableSize === nextSize;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      });

      if (this.closeButton) {
        this.closeButton.classList.toggle("hidden", nextSize !== "fullscreen");
      }
      if (nextSize === "fullscreen" && !wasFullscreen && this.closeButton) {
        window.requestAnimationFrame(() => {
          if (this.size === "fullscreen") {
            this.closeButton.focus({ preventScroll: true });
          }
        });
      }
      if (wasFullscreen && nextSize !== "fullscreen" && options.restoreFocus !== false) {
        const focusTarget = options.trigger || this.fullscreenTrigger;
        if (focusTarget instanceof HTMLElement && focusTarget.isConnected) {
          focusTarget.focus({ preventScroll: true });
        } else {
          this.wrapper.focus?.({ preventScroll: true });
        }
        this.fullscreenTrigger = null;
      }
      if (options.render !== false) {
        this.scheduleRender(true);
      }
    }

    exitFullscreen() {
      if (this.size !== "fullscreen") {
        return;
      }
      this.setSize(this.sizeBeforeFullscreen, { restoreFocus: true });
    }

    scheduleRender(force = false) {
      if (this.destroyed) {
        return;
      }
      if (force) {
        this.renderRequestId += 1;
      }
      if (this.frameId) {
        return;
      }
      this.frameId = window.requestAnimationFrame(() => {
        this.frameId = 0;
        void this.renderNow();
      });
    }

    calculateRange() {
      if (!this.totalCount) {
        return { start: 0, end: 0, firstVisible: 0, visibleCount: 0 };
      }

      const containerHeight = Math.max(this.viewport.clientHeight, ROW_HEIGHT);
      const firstVisible = Math.max(
        0,
        Math.min(this.totalCount - 1, Math.floor(this.viewport.scrollTop / ROW_HEIGHT)),
      );
      const visibleCount = Math.max(1, Math.ceil(containerHeight / ROW_HEIGHT));
      let start = Math.max(0, firstVisible - BUFFER_ROWS);
      let end = Math.min(
        this.totalCount,
        firstVisible + visibleCount + BUFFER_ROWS,
      );

      if (end - start > MAX_DOM_ROWS) {
        const spareRows = Math.max(0, MAX_DOM_ROWS - Math.min(visibleCount, MAX_DOM_ROWS));
        start = Math.max(0, firstVisible - Math.floor(spareRows / 2));
        end = Math.min(this.totalCount, start + MAX_DOM_ROWS);
        start = Math.max(0, end - MAX_DOM_ROWS);
      }
      return { start, end, firstVisible, visibleCount };
    }

    async renderNow() {
      const requestId = ++this.renderRequestId;
      const revision = this.dataRevision;
      const range = this.calculateRange();
      this.lastRange = { start: range.start, end: range.end };

      if (!this.totalCount) {
        this.updateGeometry();
        return;
      }

      const chunkIndexes = this.chunkIndexesForRange(range.start, range.end);
      this.setLoading(true);
      try {
        await Promise.all(chunkIndexes.map((chunkIndex) => (
          this.loadChunk(chunkIndex, revision)
        )));
        if (
          requestId !== this.renderRequestId
          || revision !== this.dataRevision
          || this.destroyed
        ) {
          return;
        }

        const fragment = document.createDocumentFragment();
        for (let index = range.start; index < range.end; index += 1) {
          const file = this.fileAt(index);
          const row = file
            ? this.renderRow(file, index)
            : this.createUnavailableRow(index);
          row.style.position = "absolute";
          row.style.top = `${index * ROW_HEIGHT}px`;
          row.style.height = `${ROW_HEIGHT}px`;
          row.style.pointerEvents = "auto";
          fragment.appendChild(row);
        }
        this.rows.replaceChildren(fragment);
        this.syncHeaderScroll(true);
        const currentScrollTop = this.viewport.scrollTop;
        const movingDown = currentScrollTop >= this.lastScrollTop;
        this.prefetchForRange(range, revision, movingDown);
        this.lastScrollTop = currentScrollTop;
      } catch (error) {
        if (requestId === this.renderRequestId && revision === this.dataRevision) {
          this.onError(error);
        }
      } finally {
        if (requestId === this.renderRequestId) {
          this.setLoading(false);
        }
      }
    }

    chunkIndexesForRange(start, end) {
      if (end <= start) {
        return [];
      }
      const first = Math.floor(start / CHUNK_SIZE);
      const last = Math.floor((end - 1) / CHUNK_SIZE);
      const indexes = [];
      for (let chunkIndex = first; chunkIndex <= last; chunkIndex += 1) {
        indexes.push(chunkIndex);
      }
      return indexes;
    }

    isChunkRelevant(chunkIndex) {
      if (!this.totalCount || this.lastRange.end <= this.lastRange.start) {
        return false;
      }
      const first = Math.floor(this.lastRange.start / CHUNK_SIZE);
      const last = Math.floor((this.lastRange.end - 1) / CHUNK_SIZE);
      return chunkIndex >= first - 1 && chunkIndex <= last + 1;
    }

    async loadChunk(chunkIndex, revision = this.dataRevision) {
      if (revision !== this.dataRevision) {
        return null;
      }
      if (this.cache.has(chunkIndex)) {
        const cached = this.cache.get(chunkIndex);
        this.touchCache(chunkIndex, cached);
        return cached;
      }

      const inFlightKey = `${revision}:${chunkIndex}`;
      if (this.inFlight.has(inFlightKey)) {
        return this.inFlight.get(inFlightKey);
      }

      const start = chunkIndex * CHUNK_SIZE;
      const chunkIds = this.ids.slice(start, start + CHUNK_SIZE);
      const promise = Promise.resolve(this.getFilesByIds(chunkIds))
        .then((result) => {
          if (revision !== this.dataRevision) {
            return null;
          }
          const files = normalizeFiles(result);
          const byId = new Map(files.map((file) => [String(file.id), file]));
          const aligned = chunkIds.map((id) => byId.get(String(id)) || null);
          const chunk = { start, files: aligned };
          if (!this.isChunkRelevant(chunkIndex)) {
            return chunk;
          }
          this.touchCache(chunkIndex, chunk);
          this.trimCache();
          return chunk;
        })
        .finally(() => {
          this.inFlight.delete(inFlightKey);
        });

      this.inFlight.set(inFlightKey, promise);
      return promise;
    }

    touchCache(chunkIndex, value) {
      this.cache.delete(chunkIndex);
      this.cache.set(chunkIndex, value);
    }

    trimCache() {
      while (this.cache.size > MAX_CACHE_CHUNKS) {
        const oldestKey = this.cache.keys().next().value;
        this.cache.delete(oldestKey);
      }
    }

    fileAt(index) {
      const chunkIndex = Math.floor(index / CHUNK_SIZE);
      const chunk = this.cache.get(chunkIndex);
      return chunk?.files[index - chunk.start] || null;
    }

    prefetchForRange(range, revision, movingDown) {
      if (revision !== this.dataRevision || !this.totalCount) {
        return;
      }
      const firstChunk = Math.floor(range.start / CHUNK_SIZE);
      const lastChunk = Math.floor(Math.max(range.end - 1, 0) / CHUNK_SIZE);
      const candidate = movingDown ? lastChunk + 1 : firstChunk - 1;
      const maxChunk = Math.floor((this.totalCount - 1) / CHUNK_SIZE);
      if (candidate >= 0 && candidate <= maxChunk && !this.cache.has(candidate)) {
        void this.loadChunk(candidate, revision).catch(() => {
          // Prefetch failures are surfaced if the range becomes visible.
        });
      }
    }

    createFileRow(file, index) {
      const row = document.createElement("div");
      row.className = "virtual-table-row";
      row.setAttribute("role", "row");
      row.setAttribute("aria-rowindex", String(index + 2));
      row.dataset.index = String(index);
      row.dataset.fileId = String(file.id ?? "");
      if (file.path) {
        row.title = file.path;
      }

      const values = [
        { value: file.name ?? "-", title: file.path || file.name },
        { value: file.extension || "(拡張子なし)" },
        { value: Common.formatBytes?.(file.size) ?? String(file.size ?? 0) },
        {
          value: Common.formatDate?.(
            file.lastModified ?? file.modifiedAt ?? file.modified_at,
          ) ?? "-",
        },
        {
          value: file.parentPath ?? file.parent ?? "-",
          title: file.parentPath ?? file.parent,
          className: "mono",
        },
      ];

      for (const item of values) {
        const cell = document.createElement("div");
        cell.className = `virtual-table-cell${item.className ? ` ${item.className}` : ""}`;
        cell.setAttribute("role", "cell");
        cell.textContent = item.value;
        if (item.title) {
          cell.title = item.title;
        }
        row.appendChild(cell);
      }
      return row;
    }

    createUnavailableRow(index) {
      const row = document.createElement("div");
      row.className = "virtual-table-row virtual-table-row-error";
      row.setAttribute("role", "row");
      row.setAttribute("aria-rowindex", String(index + 2));
      row.dataset.index = String(index);
      const cell = document.createElement("div");
      cell.className = "virtual-table-cell virtual-table-cell-span";
      cell.setAttribute("role", "cell");
      cell.style.gridColumn = "1 / -1";
      cell.textContent = "ファイル情報を読み込めませんでした。";
      row.appendChild(cell);
      return row;
    }

    setLoading(isLoading) {
      this.viewport.setAttribute("aria-busy", String(isLoading));
      if (!this.loading) {
        return;
      }
      this.loading.classList.toggle("hidden", !isLoading);
      this.loading.setAttribute("aria-hidden", String(!isLoading));
    }

    syncHeaderScroll(recalculate = false) {
      if (!this.header) {
        return;
      }
      if (recalculate) {
        this.header.style.width = "";
        this.rows.style.width = "";
        const contentWidth = Math.max(
          this.viewport.clientWidth,
          this.viewport.scrollWidth,
        );
        this.header.style.width = `${contentWidth}px`;
        this.rows.style.width = `${contentWidth}px`;
      }
      this.header.style.transform = `translateX(${-this.viewport.scrollLeft}px)`;
    }

    getState() {
      return {
        totalCount: this.totalCount,
        startIndex: this.lastRange.start,
        endIndex: this.lastRange.end,
        renderedRows: this.rows.children.length,
        cachedChunks: [...this.cache.keys()],
        loadingChunks: this.inFlight.size,
        scrollTop: this.viewport.scrollTop,
        size: this.size,
      };
    }

    destroy() {
      this.destroyed = true;
      this.renderRequestId += 1;
      if (this.frameId) {
        window.cancelAnimationFrame(this.frameId);
      }
      this.viewport.removeEventListener("scroll", this.handleScroll);
      document.removeEventListener("keydown", this.handleEscape);
      this.boundListeners.forEach(([target, type, handler]) => {
        target.removeEventListener(type, handler);
      });
      this.resizeObserver?.disconnect();
      if (this.handleWindowResize) {
        window.removeEventListener("resize", this.handleWindowResize);
      }
      document.body.classList.remove("virtual-table-fullscreen-open");
      this.cache.clear();
      this.inFlight.clear();
    }
  }

  app.VirtualFileTable = VirtualFileTable;
  app.VirtualTable = Object.freeze({
    VirtualFileTable,
    ROW_HEIGHT,
    BUFFER_ROWS,
    MAX_DOM_ROWS,
    CHUNK_SIZE,
    MAX_CACHE_CHUNKS,
  });
})();
