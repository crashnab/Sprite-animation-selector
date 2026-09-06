(function () {
  'use strict';

  const THUMB_WIDTH = 150;
  const THUMB_BATCH = 4;
  const GIF_WORKER =
    'https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js';
  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tif{1,2})$/i;

  /** @type {Map<string, { id: string, name: string, file: File, thumbUrl: string, width: number, height: number }>} */
  const sources = new Map();

  /** @type {Array<{ id: string, sourceId: string, duration: number }>} */
  let timeline = [];

  /** @type {Map<string, ImageBitmap>} */
  const bitmapCache = new Map();
  const CACHE_LIMIT = 3;

  let playing = false;
  let rafId = null;
  let playStart = 0;
  let playOffsetMs = 0;
  let expandedIndex = 0;
  let busy = false;
  let naturalSize = { width: 1920, height: 1080 };

  const els = {
    folderInput: document.getElementById('folder-input'),
    loadStatus: document.getElementById('load-status'),
    thumbGrid: document.getElementById('thumb-grid'),
    canvas: document.getElementById('preview-canvas'),
    previewEmpty: document.getElementById('preview-empty'),
    btnPlay: document.getElementById('btn-play'),
    btnStepBack: document.getElementById('btn-step-back'),
    btnStepForward: document.getElementById('btn-step-forward'),
    fpsInput: document.getElementById('fps-input'),
    scrub: document.getElementById('scrub-slider'),
    frameInfo: document.getElementById('frame-info'),
    timeline: document.getElementById('timeline'),
    timelineEmpty: document.getElementById('timeline-empty'),
    exportStatus: document.getElementById('export-status'),
    btnGif: document.getElementById('btn-export-gif'),
    btnPsd: document.getElementById('btn-export-psd'),
    btnZip: document.getElementById('btn-export-zip'),
  };

  const ctx = els.canvas.getContext('2d', { alpha: false });

  function naturalSortName(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  }

  function uid(prefix) {
    return prefix + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function getFps() {
    const n = Number(els.fpsInput.value);
    return Number.isFinite(n) && n >= 1 ? Math.min(60, Math.floor(n)) : 12;
  }

  function frameMs() {
    return 1000 / getFps();
  }

  /** Expand timeline into hold ticks: { timelineIndex, sourceId }[] */
  function buildExpanded() {
    const out = [];
    timeline.forEach((item, timelineIndex) => {
      const holds = Math.max(1, Math.floor(item.duration) || 1);
      for (let i = 0; i < holds; i++) {
        out.push({ timelineIndex, sourceId: item.sourceId, itemId: item.id });
      }
    });
    return out;
  }

  function revokeAllThumbs() {
    sources.forEach((s) => {
      if (s.thumbUrl) URL.revokeObjectURL(s.thumbUrl);
    });
  }

  function clearBitmapCache() {
    bitmapCache.forEach((bmp) => {
      try {
        bmp.close();
      } catch (_) {
        /* ignore */
      }
    });
    bitmapCache.clear();
  }

  function touchCache(sourceId, bitmap) {
    if (bitmapCache.has(sourceId)) {
      const old = bitmapCache.get(sourceId);
      if (old !== bitmap) {
        try {
          old.close();
        } catch (_) {
          /* ignore */
        }
      }
      bitmapCache.delete(sourceId);
    }
    bitmapCache.set(sourceId, bitmap);
    while (bitmapCache.size > CACHE_LIMIT) {
      const oldest = bitmapCache.keys().next().value;
      const bmp = bitmapCache.get(oldest);
      bitmapCache.delete(oldest);
      try {
        bmp.close();
      } catch (_) {
        /* ignore */
      }
    }
  }

  async function loadBitmap(sourceId) {
    if (bitmapCache.has(sourceId)) {
      const bmp = bitmapCache.get(sourceId);
      touchCache(sourceId, bmp);
      return bmp;
    }
    const source = sources.get(sourceId);
    if (!source) return null;
    const url = URL.createObjectURL(source.file);
    try {
      const bmp = await createImageBitmap(source.file);
      touchCache(sourceId, bmp);
      naturalSize = { width: bmp.width, height: bmp.height };
      return bmp;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function makeThumbnail(file) {
    const bmp = await createImageBitmap(file);
    const scale = THUMB_WIDTH / bmp.width;
    const w = THUMB_WIDTH;
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const c = canvas.getContext('2d');
    c.drawImage(bmp, 0, 0, w, h);
    const fullW = bmp.width;
    const fullH = bmp.height;
    bmp.close();
    const blob = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.72)
    );
    return {
      thumbUrl: URL.createObjectURL(blob),
      width: fullW,
      height: fullH,
    };
  }

  async function mapPool(items, concurrency, mapper) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        results[i] = await mapper(items[i], i);
      }
    }
    const workers = [];
    for (let i = 0; i < Math.min(concurrency, items.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    return results;
  }

  function isImageFile(file) {
    if (file.type && file.type.startsWith('image/')) return true;
    return IMAGE_EXT.test(file.name);
  }

  function drawLetterbox(bitmap) {
    const cw = els.canvas.width;
    const ch = els.canvas.height;
    ctx.fillStyle = '#0c0c10';
    ctx.fillRect(0, 0, cw, ch);
    if (!bitmap) return;
    const scale = Math.min(cw / bitmap.width, ch / bitmap.height);
    const dw = bitmap.width * scale;
    const dh = bitmap.height * scale;
    const dx = (cw - dw) / 2;
    const dy = (ch - dh) / 2;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, dx, dy, dw, dh);
  }

  function resizeCanvasToPanel() {
    const wrap = els.canvas.parentElement;
    const rect = wrap.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = Math.max(1, Math.floor(rect.width));
    const cssH = Math.max(1, Math.floor(rect.height));
    els.canvas.width = Math.floor(cssW * dpr);
    els.canvas.height = Math.floor(cssH * dpr);
    els.canvas.style.width = cssW + 'px';
    els.canvas.style.height = cssH + 'px';
  }

  async function renderCurrent() {
    const expanded = buildExpanded();
    if (!expanded.length) {
      resizeCanvasToPanel();
      ctx.fillStyle = '#0c0c10';
      ctx.fillRect(0, 0, els.canvas.width, els.canvas.height);
      els.previewEmpty.classList.remove('hidden');
      els.frameInfo.textContent = 'Frame — / —';
      highlightTimeline(-1);
      updateScrubUI(0, 0);
      return;
    }
    els.previewEmpty.classList.add('hidden');
    if (expandedIndex >= expanded.length) expandedIndex = 0;
    if (expandedIndex < 0) expandedIndex = expanded.length - 1;

    const tick = expanded[expandedIndex];
    const bitmap = await loadBitmap(tick.sourceId);
    resizeCanvasToPanel();
    drawLetterbox(bitmap);
    els.frameInfo.textContent =
      'Frame ' + (expandedIndex + 1) + ' / ' + expanded.length +
      '  ·  clip ' + (tick.timelineIndex + 1);
    highlightTimeline(tick.itemId);
    updateScrubUI(expandedIndex, expanded.length - 1);
    prefetchNeighbors(expanded);
  }

  function prefetchNeighbors(expanded) {
    if (!expanded.length) return;
    const next = expanded[(expandedIndex + 1) % expanded.length];
    if (next && !bitmapCache.has(next.sourceId)) {
      loadBitmap(next.sourceId).catch(() => {});
    }
  }

  function highlightTimeline(itemId) {
    els.timeline.querySelectorAll('.timeline-item').forEach((node) => {
      node.classList.toggle('active', node.dataset.id === itemId);
    });
  }

  function updateScrubUI(value, max) {
    els.scrub.max = String(Math.max(0, max));
    els.scrub.value = String(value);
    els.scrub.disabled = max <= 0;
    const pct = max > 0 ? (value / max) * 100 : 0;
    els.scrub.style.setProperty('--scrub-pct', pct + '%');
  }

  function updateExportButtons() {
    const enabled = timeline.length > 0 && !busy;
    els.btnGif.disabled = !enabled;
    els.btnPsd.disabled = !enabled;
    els.btnZip.disabled = !enabled;
  }

  function setBusy(state, message) {
    busy = state;
    els.exportStatus.textContent = message || '';
    els.folderInput.disabled = state;
    updateExportButtons();
  }

  function stopPlayback() {
    playing = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    els.btnPlay.innerHTML = '&#9654;';
    els.btnPlay.setAttribute('aria-label', 'Play');
  }

  function startPlayback() {
    const expanded = buildExpanded();
    if (!expanded.length) return;
    playing = true;
    playStart = performance.now();
    playOffsetMs = expandedIndex * frameMs();
    els.btnPlay.innerHTML = '&#10074;&#10074;';
    els.btnPlay.setAttribute('aria-label', 'Pause');
    tickPlayback();
  }

  function tickPlayback() {
    if (!playing) return;
    const expanded = buildExpanded();
    if (!expanded.length) {
      stopPlayback();
      return;
    }
    const elapsed = performance.now() - playStart + playOffsetMs;
    const totalMs = expanded.length * frameMs();
    const pos = ((elapsed % totalMs) + totalMs) % totalMs;
    const idx = Math.min(expanded.length - 1, Math.floor(pos / frameMs()));
    if (idx !== expandedIndex) {
      expandedIndex = idx;
      renderCurrent();
    }
    rafId = requestAnimationFrame(tickPlayback);
  }

  function togglePlay() {
    if (playing) {
      const expanded = buildExpanded();
      playOffsetMs = expandedIndex * frameMs();
      stopPlayback();
    } else {
      startPlayback();
    }
  }

  function step(delta) {
    const wasPlaying = playing;
    if (wasPlaying) stopPlayback();
    const expanded = buildExpanded();
    if (!expanded.length) return;
    expandedIndex = (expandedIndex + delta + expanded.length) % expanded.length;
    playOffsetMs = expandedIndex * frameMs();
    renderCurrent();
  }

  function renderSidebar() {
    els.thumbGrid.innerHTML = '';
    const used = new Set(timeline.map((t) => t.sourceId));
    sources.forEach((source) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'thumb-item' + (used.has(source.id) ? ' in-timeline' : '');
      btn.setAttribute('role', 'listitem');
      btn.title = 'Add ' + source.name;
      btn.dataset.sourceId = source.id;
      const img = document.createElement('img');
      img.src = source.thumbUrl;
      img.alt = source.name;
      img.loading = 'lazy';
      const label = document.createElement('span');
      label.className = 'thumb-label';
      label.textContent = source.name;
      btn.appendChild(img);
      btn.appendChild(label);
      btn.addEventListener('click', () => addToTimeline(source.id));
      els.thumbGrid.appendChild(btn);
    });
  }

  function addToTimeline(sourceId) {
    if (!sources.has(sourceId) || busy) return;
    timeline.push({
      id: uid('tl'),
      sourceId,
      duration: 1,
    });
    expandedIndex = Math.max(0, buildExpanded().length - 1);
    renderTimeline();
    renderSidebar();
    updateExportButtons();
    renderCurrent();
  }

  function removeFromTimeline(itemId) {
    const idx = timeline.findIndex((t) => t.id === itemId);
    if (idx === -1) return;
    timeline.splice(idx, 1);
    const expanded = buildExpanded();
    if (expandedIndex >= expanded.length) {
      expandedIndex = Math.max(0, expanded.length - 1);
    }
    if (playing && !expanded.length) stopPlayback();
    renderTimeline();
    renderSidebar();
    updateExportButtons();
    renderCurrent();
  }

  function renderTimeline() {
    els.timeline.innerHTML = '';
    const empty = timeline.length === 0;
    els.timelineEmpty.classList.toggle('hidden', !empty);

    timeline.forEach((item, index) => {
      const source = sources.get(item.sourceId);
      if (!source) return;

      const card = document.createElement('div');
      card.className = 'timeline-item';
      card.dataset.id = item.id;
      card.setAttribute('role', 'listitem');

      const thumb = document.createElement('div');
      thumb.className = 'timeline-thumb';
      const img = document.createElement('img');
      img.src = source.thumbUrl;
      img.alt = source.name;
      const badge = document.createElement('span');
      badge.className = 'order-badge';
      badge.textContent = String(index + 1);
      thumb.appendChild(img);
      thumb.appendChild(badge);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn-remove';
      remove.title = 'Remove frame';
      remove.setAttribute('aria-label', 'Remove frame');
      remove.textContent = '×';
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        removeFromTimeline(item.id);
      });

      const durationRow = document.createElement('label');
      durationRow.className = 'duration-row';
      durationRow.innerHTML = '<span>Hold</span>';
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '1';
      input.max = '120';
      input.value = String(item.duration);
      input.addEventListener('change', () => {
        const v = Math.max(1, Math.min(120, Math.floor(Number(input.value)) || 1));
        input.value = String(v);
        item.duration = v;
        const exp = buildExpanded();
        if (expandedIndex >= exp.length) expandedIndex = Math.max(0, exp.length - 1);
        playOffsetMs = expandedIndex * frameMs();
        renderCurrent();
      });
      input.addEventListener('pointerdown', (e) => e.stopPropagation());
      durationRow.appendChild(input);
      durationRow.appendChild(document.createTextNode('f'));

      card.appendChild(remove);
      card.appendChild(thumb);
      card.appendChild(durationRow);
      els.timeline.appendChild(card);
    });
  }

  const sortable = Sortable.create(els.timeline, {
    animation: 160,
    draggable: '.timeline-item',
    delay: 80,
    delayOnTouchOnly: true,
    touchStartThreshold: 4,
    forceFallback: false,
    onEnd: function () {
      const ids = Array.from(els.timeline.querySelectorAll('.timeline-item')).map(
        (n) => n.dataset.id
      );
      const map = new Map(timeline.map((t) => [t.id, t]));
      timeline = ids.map((id) => map.get(id)).filter(Boolean);
      renderTimeline();
      renderCurrent();
    },
  });

  async function handleFolderChange(event) {
    const fileList = Array.from(event.target.files || []).filter(isImageFile);
    if (!fileList.length) {
      els.loadStatus.textContent = 'No image files found in that folder';
      return;
    }

    stopPlayback();
    clearBitmapCache();
    revokeAllThumbs();
    sources.clear();
    timeline = [];
    expandedIndex = 0;

    fileList.sort((a, b) => naturalSortName(a.name, b.name));
    setBusy(true, 'Generating thumbnails…');
    els.loadStatus.textContent = 'Loading 0 / ' + fileList.length;

    let done = 0;
    await mapPool(fileList, THUMB_BATCH, async (file) => {
      try {
        const thumb = await makeThumbnail(file);
        const id = uid('src');
        sources.set(id, {
          id,
          name: file.name,
          file,
          thumbUrl: thumb.thumbUrl,
          width: thumb.width,
          height: thumb.height,
        });
        if (!naturalSize.width || sources.size === 1) {
          naturalSize = { width: thumb.width, height: thumb.height };
        }
      } catch (err) {
        console.warn('Failed to thumbnail', file.name, err);
      }
      done += 1;
      els.loadStatus.textContent = 'Loading ' + done + ' / ' + fileList.length;
    });

    // Re-insert in sorted order (Map insertion may be concurrent)
    const ordered = Array.from(sources.values()).sort((a, b) =>
      naturalSortName(a.name, b.name)
    );
    sources.clear();
    ordered.forEach((s) => sources.set(s.id, s));

    setBusy(false, '');
    els.loadStatus.textContent =
      sources.size + ' image' + (sources.size === 1 ? '' : 's') + ' loaded';
    renderSidebar();
    renderTimeline();
    updateExportButtons();
    await renderCurrent();
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function decodeToCanvas(source) {
    const bmp = await createImageBitmap(source.file);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const c = canvas.getContext('2d');
    c.drawImage(bmp, 0, 0);
    bmp.close();
    return canvas;
  }

  async function exportZip() {
    if (!timeline.length || busy) return;
    setBusy(true, 'Building ZIP…');
    try {
      const zip = new JSZip();
      for (let i = 0; i < timeline.length; i++) {
        const source = sources.get(timeline[i].sourceId);
        if (!source) continue;
        const ext = (source.name.match(/\.([^.]+)$/) || [, 'png'])[1].toLowerCase();
        const name = 'frame_' + String(i + 1).padStart(3, '0') + '.' + ext;
        zip.file(name, source.file);
        els.exportStatus.textContent =
          'Building ZIP… ' + (i + 1) + ' / ' + timeline.length;
        await yieldToUI();
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, 'sprite-sequence.zip');
      setBusy(false, 'ZIP downloaded');
    } catch (err) {
      console.error(err);
      setBusy(false, 'ZIP export failed');
    }
  }

  function yieldToUI() {
    return new Promise((r) => setTimeout(r, 0));
  }

  async function exportGif() {
    if (!timeline.length || busy) return;
    if (typeof GIF === 'undefined') {
      setBusy(false, 'gif.js failed to load');
      return;
    }
    setBusy(true, 'Encoding GIF…');
    try {
      const fps = getFps();
      const delayUnit = 1000 / fps;

      // Determine output size from first frame
      const first = sources.get(timeline[0].sourceId);
      const probe = await createImageBitmap(first.file);
      const outW = probe.width;
      const outH = probe.height;
      probe.close();

      await new Promise((resolve, reject) => {
        const gif = new GIF({
          workers: 2,
          quality: 10,
          width: outW,
          height: outH,
          workerScript: GIF_WORKER,
        });

        gif.on('finished', (blob) => {
          downloadBlob(blob, 'sprite-animation.gif');
          resolve();
        });
        gif.on('progress', (p) => {
          els.exportStatus.textContent =
            'Encoding GIF… ' + Math.round(p * 100) + '%';
        });

        (async () => {
          try {
            for (let i = 0; i < timeline.length; i++) {
              const item = timeline[i];
              const source = sources.get(item.sourceId);
              const canvas = await decodeToCanvas(source);
              // Scale if sizes differ
              if (canvas.width !== outW || canvas.height !== outH) {
                const scaled = document.createElement('canvas');
                scaled.width = outW;
                scaled.height = outH;
                scaled.getContext('2d').drawImage(canvas, 0, 0, outW, outH);
                gif.addFrame(scaled, {
                  delay: Math.max(20, Math.round(item.duration * delayUnit)),
                  copy: true,
                });
              } else {
                gif.addFrame(canvas, {
                  delay: Math.max(20, Math.round(item.duration * delayUnit)),
                  copy: true,
                });
              }
              els.exportStatus.textContent =
                'Adding GIF frames… ' + (i + 1) + ' / ' + timeline.length;
              await yieldToUI();
            }
            gif.render();
          } catch (e) {
            reject(e);
          }
        })();
      });

      setBusy(false, 'GIF downloaded');
    } catch (err) {
      console.error(err);
      setBusy(false, 'GIF export failed — try fewer / smaller frames');
    }
  }

  async function exportPsd() {
    if (!timeline.length || busy) return;
    const ag = window.agPsd;
    if (!ag || typeof ag.writePsd !== 'function') {
      setBusy(false, 'ag-psd failed to load');
      return;
    }
    setBusy(true, 'Building PSD…');
    try {
      const first = sources.get(timeline[0].sourceId);
      const probe = await createImageBitmap(first.file);
      const width = probe.width;
      const height = probe.height;
      probe.close();

      const children = [];
      for (let i = 0; i < timeline.length; i++) {
        const source = sources.get(timeline[i].sourceId);
        const canvas = await decodeToCanvas(source);
        let layerCanvas = canvas;
        if (canvas.width !== width || canvas.height !== height) {
          layerCanvas = document.createElement('canvas');
          layerCanvas.width = width;
          layerCanvas.height = height;
          layerCanvas.getContext('2d').drawImage(canvas, 0, 0, width, height);
        }
        children.push({
          name: 'Frame ' + String(i + 1).padStart(3, '0') + ' — ' + source.name,
          canvas: layerCanvas,
          left: 0,
          top: 0,
          opacity: 1,
          blendMode: 'normal',
        });
        els.exportStatus.textContent =
          'Building PSD layers… ' + (i + 1) + ' / ' + timeline.length;
        await yieldToUI();
      }

      // Composite preview from top-most visible layer (last frame)
      const composite = document.createElement('canvas');
      composite.width = width;
      composite.height = height;
      composite.getContext('2d').drawImage(children[children.length - 1].canvas, 0, 0);

      const psd = {
        width,
        height,
        children,
        canvas: composite,
      };

      const buffer = ag.writePsd(psd);
      const blob = new Blob([buffer], { type: 'image/vnd.adobe.photoshop' });
      downloadBlob(blob, 'sprite-layers.psd');
      setBusy(false, 'PSD downloaded');
    } catch (err) {
      console.error(err);
      setBusy(false, 'PSD export failed — try fewer frames');
    }
  }

  // Events
  els.folderInput.addEventListener('change', handleFolderChange);
  els.btnPlay.addEventListener('click', togglePlay);
  els.btnStepBack.addEventListener('click', () => step(-1));
  els.btnStepForward.addEventListener('click', () => step(1));
  els.fpsInput.addEventListener('change', () => {
    playOffsetMs = expandedIndex * frameMs();
    if (!playing) renderCurrent();
  });
  els.scrub.addEventListener('input', () => {
    const wasPlaying = playing;
    if (wasPlaying) stopPlayback();
    expandedIndex = Number(els.scrub.value) || 0;
    playOffsetMs = expandedIndex * frameMs();
    const max = Number(els.scrub.max) || 0;
    const pct = max > 0 ? (expandedIndex / max) * 100 : 0;
    els.scrub.style.setProperty('--scrub-pct', pct + '%');
    renderCurrent();
  });
  els.btnGif.addEventListener('click', exportGif);
  els.btnPsd.addEventListener('click', exportPsd);
  els.btnZip.addEventListener('click', exportZip);

  window.addEventListener('resize', () => {
    renderCurrent();
  });

  // Initial empty canvas
  resizeCanvasToPanel();
  ctx.fillStyle = '#0c0c10';
  ctx.fillRect(0, 0, els.canvas.width, els.canvas.height);
  updateExportButtons();
})();
