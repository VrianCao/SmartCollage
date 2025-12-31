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

function insetRect(rect: Rect, inset: number): Rect {
  const insetClamped = Math.max(0, inset);
  return {
    x: rect.x + insetClamped,
    y: rect.y + insetClamped,
    width: Math.max(0, rect.width - insetClamped * 2),
    height: Math.max(0, rect.height - insetClamped * 2),
  };
}

function computeRegions(size: number, mainRatio: number): {
  mainRect: Rect;
  regions: Region[];
} {
  const safeRatio = clamp(mainRatio, 0.05, 0.95);
  const mainSize = Math.round(size * safeRatio);
  const ringThickness = (size - mainSize) / 2;
  const ringT = Math.max(0, ringThickness);

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

function computeGrid(count: number, width: number, height: number): { rows: number; cols: number } {
  const n = Math.max(0, Math.floor(count));
  if (n === 0) return { rows: 0, cols: 0 };
  if (width <= 0 || height <= 0) return { rows: 1, cols: n };

  let best = { rows: 1, cols: n, score: Number.POSITIVE_INFINITY };

  for (let rows = 1; rows <= n; rows++) {
    const cols = Math.ceil(n / rows);
    const cellW = width / cols;
    const cellH = height / rows;
    const aspect = cellH === 0 ? 999 : cellW / cellH;
    const squareness = Math.abs(Math.log(aspect));
    const waste = rows * cols - n;
    const score = squareness * 2 + waste / Math.max(1, n);

    if (score < best.score) best = { rows, cols, score };
  }

  return { rows: best.rows, cols: best.cols };
}

function buildCells(rect: Rect, count: number): Rect[] {
  const n = Math.max(0, Math.floor(count));
  if (n === 0 || rect.width <= 0 || rect.height <= 0) return [];

  const { rows, cols } = computeGrid(n, rect.width, rect.height);
  if (rows === 0 || cols === 0) return [];

  const cellW = rect.width / cols;
  const cellH = rect.height / rows;

  const cells: Rect[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;

    const remaining = n - row * cols;
    const itemsInThisRow = Math.min(cols, remaining);
    const rowXOffset = itemsInThisRow === cols ? 0 : (rect.width - itemsInThisRow * cellW) / 2;

    cells.push({
      x: rect.x + rowXOffset + col * cellW,
      y: rect.y + row * cellH,
      width: cellW,
      height: cellH,
    });
  }
  return cells;
}

export function computeCollageLayout(options: CollageLayoutOptions): CollageLayout {
  const size = Math.max(64, Math.floor(options.size));
  const gap = clamp(options.gap, 0, Math.floor(size / 10));
  const othersCount = Math.max(0, Math.floor(options.othersCount));

  const { mainRect, regions } = computeRegions(size, options.mainRatio);
  const counts = allocateCounts(othersCount, regions);

  const gapInset = gap / 2;
  const ringCells: Rect[] = [];
  for (const region of regions) {
    const regionCells = buildCells(region.rect, counts[region.name]).map((r) =>
      insetRect(r, gapInset),
    );
    ringCells.push(...regionCells);
  }

  return {
    size,
    gap,
    mainRect: insetRect(mainRect, gapInset),
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

  const main = images.find((i) => i.id === mainId) ?? images[0];
  const others = images.filter((i) => i.id !== main.id);
  const othersOrdered = [...others];
  if (options.shuffleOthers) shuffleInPlace(othersOrdered);

  onProgress?.({ phase: "layout", done: 0, total: 1, message: "计算布局…" });
  const layout = computeCollageLayout({
    size,
    mainRatio: options.mainRatio,
    gap: options.gap,
    othersCount: othersOrdered.length,
  });

  ctx.save();
  ctx.fillStyle = options.background;
  ctx.fillRect(0, 0, size, size);
  ctx.restore();

  const totalToDraw = othersOrdered.length + 1;
  let drawn = 0;

  for (let idx = 0; idx < othersOrdered.length; idx++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const item = othersOrdered[idx];
    const dest = layout.ringCells[idx];
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

