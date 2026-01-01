export type Rect = { x: number; y: number; width: number; height: number };

export type CollageProgressPhase = "layout" | "decode" | "render" | "export";

export type CollageProgress = {
  phase: CollageProgressPhase;
  done: number;
  total: number;
  message?: string;
};

export type CollageLayoutOptions = {
  size: number;
  mainRatio: number;
  gap: number;
  othersCount: number;
};

export type CollageLayout = {
  size: number;
  gap: number;
  mainRect: Rect;
  ringCells: Rect[];
};

export type RenderCollageOptions = {
  size: number;
  mainRatio: number;
  gap: number;
  background: string;
  shuffleOthers: boolean;
  useMain: boolean;
};

export type CollageImageItem = {
  id: string;
  file: File;
};

type RegionName = "top" | "right" | "bottom" | "left";
type Region = { name: RegionName; rect: Rect; area: number };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function distribute(total: number, parts: number): number[] {
  const safeParts = Math.max(1, Math.floor(parts));
  const safeTotal = Math.max(0, Math.floor(total));
  const base = Math.floor(safeTotal / safeParts);
  const rem = safeTotal - base * safeParts;
  return Array.from({ length: safeParts }, (_, i) => base + (i < rem ? 1 : 0));
}

function computeRegions(size: number, mainRatio: number): {
  mainRect: Rect;
  regions: Region[];
} {
  const safeRatio = clamp(mainRatio, 0.05, 0.95);
  let mainSize = Math.round(size * safeRatio);
  mainSize = clamp(mainSize, 1, size);
  // Keep ring thickness integer to avoid sub-pixel seams on canvas.
  if ((size - mainSize) % 2 !== 0) {
    const down = mainSize - 1;
    const up = mainSize + 1;
    if (down >= 1 && (size - down) % 2 === 0) mainSize = down;
    else if (up <= size && (size - up) % 2 === 0) mainSize = up;
  }
  const ringT = Math.max(0, (size - mainSize) / 2);

  const mainRect: Rect = {
    x: ringT,
    y: ringT,
    width: mainSize,
    height: mainSize,
  };

  const top: Rect = { x: 0, y: 0, width: size, height: ringT };
  const bottom: Rect = { x: 0, y: ringT + mainSize, width: size, height: ringT };
  const left: Rect = { x: 0, y: ringT, width: ringT, height: mainSize };
  const right: Rect = { x: ringT + mainSize, y: ringT, width: ringT, height: mainSize };

  const regions: Region[] = [
    { name: "top", rect: top, area: top.width * top.height },
    { name: "right", rect: right, area: right.width * right.height },
    { name: "bottom", rect: bottom, area: bottom.width * bottom.height },
    { name: "left", rect: left, area: left.width * left.height },
  ];

  return { mainRect, regions };
}

function allocateCounts(total: number, regions: Region[]): Record<RegionName, number> {
  const safeTotal = Math.max(0, Math.floor(total));
  const ringArea = regions.reduce((sum, r) => sum + r.area, 0);
  if (safeTotal === 0 || ringArea <= 0) {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }

  const raw = regions.map((r) => {
    const exact = (r.area / ringArea) * safeTotal;
    return { name: r.name, exact, base: Math.floor(exact), frac: exact - Math.floor(exact) };
  });

  let used = raw.reduce((sum, r) => sum + r.base, 0);
  const remaining = safeTotal - used;
  raw.sort((a, b) => b.frac - a.frac);
  for (let i = 0; i < remaining; i++) raw[i % raw.length].base += 1;

  const out: Record<RegionName, number> = { top: 0, right: 0, bottom: 0, left: 0 };
  for (const r of raw) out[r.name] = r.base;
  used = Object.values(out).reduce((sum, v) => sum + v, 0);
  if (used !== safeTotal) {
    const diff = safeTotal - used;
    out.top += diff;
  }
  return out;
}

function computeBestRowsNoWaste(args: {
  count: number;
  width: number;
  height: number;
  gap: number;
}): number | null {
  const n = Math.max(0, Math.floor(args.count));
  const width = Math.max(0, Math.floor(args.width));
  const height = Math.max(0, Math.floor(args.height));
  const gap = Math.max(0, Math.floor(args.gap));
  if (n === 0 || width === 0 || height === 0) return 0;

  let bestRows: number | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  const maxRows = Math.min(n, height);
  for (let rows = 1; rows <= maxRows; rows++) {
    const availableHeight = height - gap * (rows - 1);
    if (availableHeight < rows) break;

    const base = Math.floor(n / rows);
    if (base <= 0) break;
    const extra = n - base * rows;

    const rowHeight = availableHeight / rows;
    let score = 0;
    let ok = true;
    for (let r = 0; r < rows; r++) {
      const rowCount = base + (r < extra ? 1 : 0);
      const availableWidth = width - gap * (rowCount - 1);
      if (availableWidth < rowCount) {
        ok = false;
        break;
      }
      const cellW = availableWidth / rowCount;
      const aspect = rowHeight === 0 ? 999 : cellW / rowHeight;
      score += Math.abs(Math.log(aspect)) * rowCount;
    }
    if (!ok) continue;
    if (score < bestScore) {
      bestScore = score;
      bestRows = rows;
    }
  }

  return bestRows;
}

function tryBuildCellsFilled(args: { rect: Rect; count: number; gap: number }): Rect[] | null {
  const n = Math.max(0, Math.floor(args.count));
  if (n === 0) return [];

  const gap = Math.max(0, Math.floor(args.gap));
  const x0 = Math.round(args.rect.x);
  const y0 = Math.round(args.rect.y);
  const width = Math.round(args.rect.width);
  const height = Math.round(args.rect.height);
  if (width <= 0 || height <= 0) return null;

  const rows = computeBestRowsNoWaste({ count: n, width, height, gap });
  if (rows == null || rows <= 0) return null;

  const base = Math.floor(n / rows);
  const extra = n - base * rows;
  if (base <= 0) return null;

  const rowCounts = Array.from({ length: rows }, (_, r) => base + (r < extra ? 1 : 0));
  const availableHeight = height - gap * (rows - 1);
  if (availableHeight < rows) return null;
  const rowHeights = distribute(availableHeight, rows);

  const cells: Rect[] = [];
  let y = y0;
  for (let r = 0; r < rows; r++) {
    const rowCount = rowCounts[r];
    const availableWidth = width - gap * (rowCount - 1);
    if (availableWidth < rowCount) return null;
    const colWidths = distribute(availableWidth, rowCount);

    let x = x0;
    for (let c = 0; c < rowCount; c++) {
      cells.push({ x, y, width: colWidths[c], height: rowHeights[r] });
      x += colWidths[c] + gap;
      if (cells.length === n) break;
    }

    y += rowHeights[r] + gap;
    if (cells.length === n) break;
  }

  return cells.length === n ? cells : null;
}

function buildCellsFilled(rect: Rect, count: number, gap: number): Rect[] {
  const n = Math.max(0, Math.floor(count));
  if (n === 0) return [];

  // Try the requested gap first; if impossible (region too small), fall back to a smaller gap.
  let g = Math.max(0, Math.floor(gap));
  for (let attempt = 0; attempt < 4; attempt++) {
    const cells = tryBuildCellsFilled({ rect, count: n, gap: g });
    if (cells) return cells;
    g = Math.floor(g / 2);
  }
  return tryBuildCellsFilled({ rect, count: n, gap: 0 }) ?? [];
}

export function computeCollageLayout(options: CollageLayoutOptions): CollageLayout {
  const size = Math.max(64, Math.floor(options.size));
  const gap = clamp(options.gap, 0, Math.floor(size / 8));
  const othersCount = Math.max(0, Math.floor(options.othersCount));

  const { mainRect, regions } = computeRegions(size, options.mainRatio);
  const counts = allocateCounts(othersCount, regions);

  const ringCells: Rect[] = [];
  for (const region of regions) {
    const regionCells = buildCellsFilled(region.rect, counts[region.name], gap);
    ringCells.push(...regionCells);
  }

  return {
    size,
    gap,
    mainRect,
    ringCells,
  };
}

function drawImageCover(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceW: number,
  sourceH: number,
  dest: Rect,
): void {
  if (dest.width <= 0 || dest.height <= 0 || sourceW <= 0 || sourceH <= 0) return;

  const scale = Math.max(dest.width / sourceW, dest.height / sourceH);
  const sWidth = dest.width / scale;
  const sHeight = dest.height / scale;
  const sx = (sourceW - sWidth) / 2;
  const sy = (sourceH - sHeight) / 2;

  ctx.drawImage(
    source,
    Math.max(0, sx),
    Math.max(0, sy),
    Math.max(1, sWidth),
    Math.max(1, sHeight),
    dest.x,
    dest.y,
    dest.width,
    dest.height,
  );
}

type DecodedImage = {
  source: CanvasImageSource;
  width: number;
  height: number;
  close?: () => void;
};

async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(
        file,
        // Some TS DOM lib versions lag behind; cast to keep builds green.
        { imageOrientation: "from-image" } as unknown as ImageBitmapOptions,
      );
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch {
      // Fall back below.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export async function renderCollageToCanvas(args: {
  canvas: HTMLCanvasElement;
  images: CollageImageItem[];
  mainId: string;
  options: RenderCollageOptions;
  signal?: AbortSignal;
  onProgress?: (progress: CollageProgress) => void;
}): Promise<void> {
  const { canvas, images, mainId, options, signal, onProgress } = args;
  if (images.length === 0) throw new Error("No images provided.");

  const size = Math.max(64, Math.floor(options.size));
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas 2D context is not available.");

  canvas.width = size;
  canvas.height = size;

  onProgress?.({ phase: "layout", done: 0, total: 1, message: "计算布局…" });

  ctx.save();
  ctx.fillStyle = options.background;
  ctx.fillRect(0, 0, size, size);
  ctx.restore();

  if (!options.useMain) {
    const ordered = [...images];
    if (options.shuffleOthers) shuffleInPlace(ordered);

    const cells = buildCellsFilled({ x: 0, y: 0, width: size, height: size }, ordered.length, options.gap);
    if (cells.length !== ordered.length) throw new Error("Layout did not allocate enough cells for images.");

    const totalToDraw = ordered.length;
    let drawn = 0;
    for (let idx = 0; idx < ordered.length; idx++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const item = ordered[idx];
      const dest = cells[idx];
      onProgress?.({
        phase: "decode",
        done: drawn,
        total: totalToDraw,
        message: `解码图片 ${drawn + 1}/${totalToDraw}…`,
      });
      const decoded = await decodeImage(item.file);
      try {
        onProgress?.({
          phase: "render",
          done: drawn,
          total: totalToDraw,
          message: `绘制图片 ${drawn + 1}/${totalToDraw}…`,
        });
        drawImageCover(ctx, decoded.source, decoded.width, decoded.height, dest);
      } finally {
        decoded.close?.();
      }
      drawn += 1;
      if (idx % 4 === 0) await nextFrame();
    }

    onProgress?.({ phase: "render", done: drawn, total: totalToDraw, message: "完成" });
    return;
  }

  const main = images.find((i) => i.id === mainId) ?? images[0];
  const others = images.filter((i) => i.id !== main.id);
  const othersOrdered = [...others];
  if (options.shuffleOthers) shuffleInPlace(othersOrdered);

  const layout = computeCollageLayout({
    size,
    mainRatio: options.mainRatio,
    gap: options.gap,
    othersCount: othersOrdered.length,
  });

  const totalToDraw = othersOrdered.length + 1;
  let drawn = 0;

  for (let idx = 0; idx < othersOrdered.length; idx++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const item = othersOrdered[idx];
    const dest = layout.ringCells[idx];
    if (!dest) throw new Error("Layout did not allocate enough cells for ring images.");
    onProgress?.({
      phase: "decode",
      done: drawn,
      total: totalToDraw,
      message: `解码图片 ${drawn + 1}/${totalToDraw}…`,
    });
    const decoded = await decodeImage(item.file);
    try {
      onProgress?.({
        phase: "render",
        done: drawn,
        total: totalToDraw,
        message: `绘制图片 ${drawn + 1}/${totalToDraw}…`,
      });
      drawImageCover(ctx, decoded.source, decoded.width, decoded.height, dest);
    } finally {
      decoded.close?.();
    }
    drawn += 1;
    if (idx % 4 === 0) await nextFrame();
  }

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  onProgress?.({
    phase: "decode",
    done: drawn,
    total: totalToDraw,
    message: "解码主图…",
  });
  const mainDecoded = await decodeImage(main.file);
  try {
    onProgress?.({
      phase: "render",
      done: drawn,
      total: totalToDraw,
      message: "绘制主图…",
    });
    drawImageCover(ctx, mainDecoded.source, mainDecoded.width, mainDecoded.height, layout.mainRect);
  } finally {
    mainDecoded.close?.();
  }

  drawn += 1;
  onProgress?.({ phase: "render", done: drawn, total: totalToDraw, message: "完成" });
}

export async function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  const safeQuality = quality == null ? undefined : clamp(quality, 0, 1);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) reject(new Error("Failed to export canvas."));
        else resolve(blob);
      },
      type,
      safeQuality,
    );
  });
}
