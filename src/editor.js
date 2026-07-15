// editor.js — 拼接整页截图、框选裁剪、保存/撤销、导出 Word / PDF / PNG。
import { Document, Packer, Paragraph, ImageRun, AlignmentType } from 'docx';
import { jsPDF } from 'jspdf';

const $ = (s) => document.querySelector(s);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const log = (...a) => console.log('[整页截图]', ...a);
const tick = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

const preview = $('#preview'); // 页面上显示用的 <img>
const overlay = $('#overlay');
const canvasWrap = $('#canvasWrap');

let baseCanvas = null; // 拼接出的原始长图，之后只读不改（撤销时从它重裁）
let fullCanvas = null; // 当前视图画布（裁剪/导出的数据源）；未裁剪时与 baseCanvas 是同一对象
let viewRect = null; // 当前视图在 baseCanvas 上的像素矩形
let dpr = 1; // 设备像素比，用于 100% 缩放换算
let crop = { x: 0, y: 0, w: 1, h: 1 }; // 单个裁剪框，归一化 0~1
let history = []; // 每次「保存裁剪」前的 viewRect，供撤销
let zoomMode = 'fit';
let drag = null;

const MAX_FULL_H = 24000; // 全分辨率长图高度上限
const MAX_VIEW_W = 2000; // 显示用缩略图尺寸上限
const MAX_VIEW_H = 18000;
const FULL = () => ({ x: 0, y: 0, w: 1, h: 1 });
const isFull = (c) => c.x <= 0.001 && c.y <= 0.001 && c.w >= 0.999 && c.h >= 0.999;

init();

async function init() {
  // 每次截图使用独立的存储键（通过 URL 传入），兼容旧的固定键
  const storageKey = new URLSearchParams(location.search).get('key') || 'captureData';
  let data;
  try {
    const r = await chrome.storage.local.get(storageKey);
    data = r[storageKey];
    // 数据已进入内存，立即清理存储：既防残留占盘，也保护隐私
    chrome.storage.local.remove(storageKey);
  } catch (e) {
    log('读取截图数据失败', e);
  }

  if (!data || !data.slices || !data.slices.length) {
    canvasWrap.hidden = true;
    $('#hint').hidden = true;
    $('#empty').hidden = false;
    return;
  }

  log('收到分片', data.slices.length, '元信息', data.meta);
  showBusy('正在拼接整页截图…');
  try {
    await stitch(data);
    dpr = data.meta.dpr || 1;
    showBusy('正在生成预览…');
    await tick();
    await rebuildPreview();
    crop = FULL();
    applyZoom('fit');
    enableActions(true);
    log('完成', fullCanvas.width, '×', fullCanvas.height);
  } catch (e) {
    log('拼接失败', e);
    alert('拼接截图失败：' + ((e && e.message) || e));
  } finally {
    hideBusy();
  }

  bindUI();
  renderOverlay();
}

/* ---------------- 拼接 ---------------- */
async function stitch({ meta, slices }) {
  const devW = Math.max(1, Math.round(meta.vw * meta.dpr));
  const devH = Math.max(1, Math.round(meta.fullH * meta.dpr));
  const fullScale = devH > MAX_FULL_H ? MAX_FULL_H / devH : 1;

  baseCanvas = makeCanvas(devW * fullScale, devH * fullScale);
  const ctx = ctxOf(baseCanvas);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, baseCanvas.width, baseCanvas.height);

  const ordered = slices.slice().sort((a, b) => a.y - b.y);
  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i];
    showBusy(`正在拼接整页截图… (${i + 1}/${ordered.length})`);
    await tick();
    if (!s || !s.dataUrl) {
      log('跳过空分片', i);
      continue;
    }
    let img;
    try {
      img = await loadImage(s.dataUrl);
    } catch (e) {
      log('分片', i, '处理失败，已跳过：', e && e.message);
      continue;
    }
    ctx.drawImage(
      img,
      0,
      Math.round(s.y * meta.dpr * fullScale),
      Math.round(img.width * fullScale),
      Math.round(img.height * fullScale),
    );
  }
  viewRect = { x: 0, y: 0, w: baseCanvas.width, h: baseCanvas.height };
  fullCanvas = baseCanvas;
}

// 按 viewRect 从原图重建当前视图画布；全图时直接复用 baseCanvas，不复制
function rebuildFullCanvas() {
  if (viewRect.w === baseCanvas.width && viewRect.h === baseCanvas.height) {
    fullCanvas = baseCanvas;
    return;
  }
  const out = makeCanvas(viewRect.w, viewRect.h);
  ctxOf(out).drawImage(
    baseCanvas,
    viewRect.x,
    viewRect.y,
    viewRect.w,
    viewRect.h,
    0,
    0,
    viewRect.w,
    viewRect.h,
  );
  fullCanvas = out;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function ctxOf(c) {
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('无法创建画布（页面过长，内存不足）');
  return ctx;
}

function loadImage(src) {
  return new Promise((res, rej) => {
    if (!src || typeof src !== 'string') {
      rej(new Error('空的截图分片'));
      return;
    }
    const img = new Image();
    const timer = setTimeout(() => rej(new Error('图片解码超时')), 20000);
    img.onload = () => {
      clearTimeout(timer);
      res(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      rej(new Error('图片解码失败'));
    };
    img.src = src;
  });
}

// 把大画布按横条逐段缩绘到小画布，避免一次性 drawImage 超大画布卡死
function downscaleCanvas(src, maxW, maxH) {
  const k = Math.min(1, maxW / src.width, maxH / src.height);
  const out = makeCanvas(src.width * k, src.height * k);
  const ctx = ctxOf(out);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  const STRIP = 1500;
  for (let sy = 0; sy < src.height; sy += STRIP) {
    const sh = Math.min(STRIP, src.height - sy);
    ctx.drawImage(
      src,
      0,
      sy,
      src.width,
      sh,
      0,
      Math.round(sy * k),
      out.width,
      Math.max(1, Math.round(sh * k)),
    );
  }
  return out;
}

// 用当前 fullCanvas 重新生成预览图
async function rebuildPreview() {
  const view = downscaleCanvas(fullCanvas, MAX_VIEW_W, MAX_VIEW_H);
  const blob = await canvasToBlob(view, 'image/jpeg', 0.92);
  const url = URL.createObjectURL(blob);
  await new Promise((res, rej) => {
    preview.onload = () => res();
    preview.onerror = () => rej(new Error('预览图加载失败'));
    preview.src = url;
  });
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

function canvasToBlob(c, type, q) {
  return new Promise((res, rej) => {
    c.toBlob((b) => (b ? res(b) : rej(new Error('生成图片失败（画布过大）'))), type, q);
  });
}

/* ---------------- 缩放 ---------------- */
function applyZoom(mode) {
  zoomMode = mode;
  document
    .querySelectorAll('.zoom button')
    .forEach((b) => b.classList.toggle('on', b.dataset.zoom === mode));
  if (mode === 'fit') {
    canvasWrap.style.width = '';
  } else {
    const logicalW = fullCanvas.width / dpr;
    canvasWrap.style.width = Math.round(logicalW * (mode === '100' ? 1 : 0.5)) + 'px';
  }
}

/* ---------------- 事件绑定 ---------------- */
function bindUI() {
  document
    .querySelectorAll('.zoom button')
    .forEach((b) => b.addEventListener('click', () => applyZoom(b.dataset.zoom)));
  $('#selectAll').addEventListener('click', () => {
    crop = FULL();
    renderOverlay();
  });
  $('#applyCrop').addEventListener('click', () => guard(applyCrop));
  $('#undo').addEventListener('click', () => guard(undo));
  $('#exportWord').addEventListener('click', () => guard(exportWord));
  $('#exportPdf').addEventListener('click', () => guard(exportPdf));
  $('#exportPng').addEventListener('click', () => guard(exportPng));
  overlay.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      crop = FULL();
      renderOverlay();
    }
  });
}

function enableActions(on) {
  ['#selectAll', '#exportWord', '#exportPdf', '#exportPng', '#pdfFormat'].forEach((s) => {
    $(s).disabled = !on;
  });
}

function updateButtons() {
  $('#applyCrop').disabled = !fullCanvas || isFull(crop);
  $('#undo').disabled = history.length === 0;
}

/* ---------------- 框选交互 ---------------- */
function relPoint(e) {
  const r = overlay.getBoundingClientRect();
  return {
    x: clamp((e.clientX - r.left) / r.width, 0, 1),
    y: clamp((e.clientY - r.top) / r.height, 0, 1),
  };
}

function onPointerDown(e) {
  if (!fullCanvas) return;
  const p = relPoint(e);
  const box = e.target.closest('.crop-box');
  const handle = e.target.closest('.crop-handle');

  if (box && handle) {
    drag = { mode: 'resize', dir: handle.dataset.dir, start: p, orig: { ...crop } };
  } else if (box) {
    drag = { mode: 'move', start: p, orig: { ...crop } };
  } else {
    drag = { mode: 'draw', start: p, orig: { ...crop } };
    crop = { x: p.x, y: p.y, w: 0, h: 0 };
  }

  overlay.setPointerCapture(e.pointerId);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  e.preventDefault();
  renderOverlay();
}

function onPointerMove(e) {
  if (!drag) return;
  const p = relPoint(e);
  const o = drag.orig;
  const dx = p.x - drag.start.x;
  const dy = p.y - drag.start.y;

  if (drag.mode === 'draw') {
    crop.x = Math.min(drag.start.x, p.x);
    crop.y = Math.min(drag.start.y, p.y);
    crop.w = Math.abs(p.x - drag.start.x);
    crop.h = Math.abs(p.y - drag.start.y);
  } else if (drag.mode === 'resize') {
    const dir = drag.dir;
    const MIN = 0.01;
    let x1 = o.x;
    let y1 = o.y;
    let x2 = o.x + o.w;
    let y2 = o.y + o.h;
    if (dir.includes('w')) x1 = clamp(o.x + dx, 0, x2 - MIN);
    if (dir.includes('e')) x2 = clamp(o.x + o.w + dx, x1 + MIN, 1);
    if (dir.includes('n')) y1 = clamp(o.y + dy, 0, y2 - MIN);
    if (dir.includes('s')) y2 = clamp(o.y + o.h + dy, y1 + MIN, 1);
    crop = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  } else if (drag.mode === 'move') {
    crop.x = clamp(o.x + dx, 0, 1 - o.w);
    crop.y = clamp(o.y + dy, 0, 1 - o.h);
  }
  renderOverlay();
}

function onPointerUp() {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  // 新框拉得太小，视为误操作，恢复原选区
  if (drag && drag.mode === 'draw' && (crop.w < 0.012 || crop.h < 0.012)) {
    crop = { ...drag.orig };
  }
  drag = null;
  renderOverlay();
}

/* ---------------- 渲染裁剪框 ---------------- */
function renderOverlay() {
  overlay.innerHTML = '';
  if (fullCanvas) {
    const box = document.createElement('div');
    box.className = 'crop-box' + (drag ? ' dragging' : '');
    box.style.left = crop.x * 100 + '%';
    box.style.top = crop.y * 100 + '%';
    box.style.width = crop.w * 100 + '%';
    box.style.height = crop.h * 100 + '%';

    const grid = document.createElement('div');
    grid.className = 'crop-grid';
    box.appendChild(grid);

    const px = cropPixels(crop);
    const dim = document.createElement('div');
    dim.className = 'crop-dim';
    dim.textContent = `${px.w} × ${px.h}px`;
    box.appendChild(dim);

    ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach((dir) => {
      const h = document.createElement('div');
      h.className = 'crop-handle h-' + dir;
      h.dataset.dir = dir;
      box.appendChild(h);
    });
    overlay.appendChild(box);
  }
  updateButtons();
}

/* ---------------- 裁剪取像素（基于全分辨率长图） ---------------- */
function cropPixels(c) {
  return {
    x: clamp(Math.round(c.x * fullCanvas.width), 0, fullCanvas.width - 1),
    y: clamp(Math.round(c.y * fullCanvas.height), 0, fullCanvas.height - 1),
    w: clamp(Math.round(c.w * fullCanvas.width), 1, fullCanvas.width),
    h: clamp(Math.round(c.h * fullCanvas.height), 1, fullCanvas.height),
  };
}

function cropToCanvas(c) {
  const p = cropPixels(c);
  const w = Math.min(p.w, fullCanvas.width - p.x);
  const h = Math.min(p.h, fullCanvas.height - p.y);
  const out = makeCanvas(w, h);
  out.getContext('2d').drawImage(fullCanvas, p.x, p.y, w, h, 0, 0, w, h);
  return out;
}

// 导出 / 保存的目标画布：当前选区
function targetCanvas() {
  return isFull(crop) ? fullCanvas : cropToCanvas(crop);
}

/* ---------------- 保存裁剪 / 撤销 ---------------- */
async function applyCrop() {
  if (isFull(crop)) return;
  const p = cropPixels(crop);
  history.push(viewRect);
  viewRect = {
    x: viewRect.x + p.x,
    y: viewRect.y + p.y,
    w: Math.min(p.w, fullCanvas.width - p.x),
    h: Math.min(p.h, fullCanvas.height - p.y),
  };
  rebuildFullCanvas();
  await rebuildPreview();
  crop = FULL();
  applyZoom(zoomMode);
  renderOverlay();
  log('已保存裁剪 →', fullCanvas.width, '×', fullCanvas.height);
}

async function undo() {
  if (!history.length) return;
  viewRect = history.pop();
  rebuildFullCanvas();
  await rebuildPreview();
  crop = FULL();
  applyZoom(zoomMode);
  renderOverlay();
  log('已撤销 →', fullCanvas.width, '×', fullCanvas.height);
}

/* ---------------- 导出 ---------------- */
async function exportPng() {
  const blob = await canvasToBlob(targetCanvas(), 'image/png');
  downloadBlob(blob, fileName('png'));
}

// 把画布按指定高度切成多个横条（用于分页）
function sliceCanvas(src, bandHeight) {
  const bands = [];
  for (let sy = 0; sy < src.height; sy += bandHeight) {
    const sh = Math.min(bandHeight, src.height - sy);
    const band = makeCanvas(src.width, sh);
    band.getContext('2d').drawImage(src, 0, sy, src.width, sh, 0, 0, src.width, sh);
    bands.push(band);
  }
  if (!bands.length) bands.push(src);
  return bands;
}

// PDF：图片按页宽铺满，过长则自动分页（满幅，无白边）
// 内嵌图片格式由工具栏选择：JPEG（质量 0.85，照片类页面体积可小 5-10 倍）或 PNG（无损，文字最清晰）
const PDF_JPEG_QUALITY = 0.85;

async function exportPdf() {
  const c = targetCanvas();
  const asJpeg = $('#pdfFormat').value !== 'png';
  const pdf = new jsPDF({ orientation: 'p', unit: 'pt', format: 'a4' });
  const pw = pdf.internal.pageSize.getWidth();
  const ph = pdf.internal.pageSize.getHeight();
  const scale = pw / c.width; // 按页宽缩放
  const bandSrcH = Math.max(1, Math.floor(ph / scale)); // 每页可容纳的源像素高度
  const bands = sliceCanvas(c, bandSrcH);
  for (let i = 0; i < bands.length; i++) {
    showBusy(`正在生成 PDF… (${i + 1}/${bands.length})`);
    await tick();
    const band = bands[i];
    if (i > 0) pdf.addPage('a4', 'p');
    if (asJpeg) {
      pdf.addImage(band.toDataURL('image/jpeg', PDF_JPEG_QUALITY), 'JPEG', 0, 0, pw, band.height * scale);
    } else {
      pdf.addImage(band, 'PNG', 0, 0, pw, band.height * scale);
    }
  }
  downloadBlob(pdf.output('blob'), fileName('pdf'));
}

// Word：图片按页宽铺满，过长则自动分页
async function exportWord() {
  const c = targetCanvas();
  const IMG_W = 790; // A4 页宽约 794px@96dpi，留极小余量避免换行
  const MAX_BAND_DISP = 1050; // 每页图片显示高度上限（A4 高约 1123px，留余量）
  const scale = IMG_W / c.width;
  const bandSrcH = Math.max(1, Math.floor(MAX_BAND_DISP / scale));
  const bands = sliceCanvas(c, bandSrcH);
  const children = [];
  for (let i = 0; i < bands.length; i++) {
    const band = bands[i];
    const buf = await (await canvasToBlob(band, 'image/png')).arrayBuffer();
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        pageBreakBefore: i > 0,
        children: [
          new ImageRun({
            type: 'png',
            data: buf,
            transformation: { width: IMG_W, height: Math.round(band.height * scale) },
          }),
        ],
      }),
    );
  }
  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 }, // A4，单位 twip
            margin: { top: 0, right: 0, bottom: 0, left: 0 },
          },
        },
        children,
      },
    ],
  });
  downloadBlob(await Packer.toBlob(doc), fileName('docx'));
}

/* ---------------- 工具 ---------------- */
function fileName(ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `整页截图-${stamp}.${ext}`;
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function guard(fn) {
  showBusy('处理中，请稍候…');
  await tick();
  try {
    await fn();
  } catch (e) {
    log('操作失败', e);
    alert('操作失败：' + ((e && e.message) || e));
  } finally {
    hideBusy();
  }
}

function showBusy(text) {
  $('#busyText').textContent = text || '处理中…';
  $('#busy').classList.add('show');
}

function hideBusy() {
  $('#busy').classList.remove('show');
}
