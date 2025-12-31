"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import {
  canvasToBlob,
  renderCollageToCanvas,
  type CollageImageItem,
  type CollageProgress,
} from "@/lib/collage";

type UiImageItem = CollageImageItem & { url: string };

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let idx = 0;
  while (n >= 1024 && idx < units.length - 1) {
    n /= 1024;
    idx += 1;
  }
  return `${n.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function safeFilenamePart(input: string): string {
  return input.replaceAll(/[^a-zA-Z0-9._-]+/g, "-").replaceAll(/-+/g, "-").slice(0, 80);
}

async function nextFrame(): Promise<void> {
  await new Promise((resolve) => requestAnimationFrame(resolve));
}

async function createDemoFiles(
  count: number,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context is not available.");

  const files: File[] = [];
  for (let i = 0; i < count; i++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const w = 900 + Math.floor(Math.random() * 900);
    const h = 600 + Math.floor(Math.random() * 900);
    canvas.width = w;
    canvas.height = h;

    const hue = (i * 31) % 360;
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, `hsl(${hue} 85% 55%)`);
    g.addColorStop(1, `hsl(${(hue + 120) % 360} 85% 45%)`);

    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.font = "bold 84px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`${i + 1}`, w / 2, h / 2);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => {
          if (!b) reject(new Error("Failed to create demo image."));
          else resolve(b);
        },
        "image/jpeg",
        0.92,
      );
    });
    files.push(new File([blob], `demo-${String(i + 1).padStart(3, "0")}.jpg`, { type: blob.type }));

    onProgress?.(i + 1, count);
    if (i % 10 === 0) await nextFrame();
  }

  return files;
}

export default function Home() {
  const [images, setImages] = useState<UiImageItem[]>([]);
  const [mainId, setMainId] = useState<string | null>(null);

  const [mainRatio, setMainRatio] = useState(0.48);
  const [gapPxAtExport, setGapPxAtExport] = useState(0);
  const [background, setBackground] = useState("#ffffff");
  const [shuffleOthers, setShuffleOthers] = useState(true);

  const [previewSize, setPreviewSize] = useState(1024);
  const [exportSize, setExportSize] = useState(4096);
  const [exportFormat, setExportFormat] = useState<"image/png" | "image/jpeg">("image/png");
  const [jpegQuality, setJpegQuality] = useState(0.92);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<CollageProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const imagesRef = useRef<UiImageItem[]>([]);

  const totalBytes = useMemo(() => images.reduce((sum, i) => sum + i.file.size, 0), [images]);
  const mainItem = useMemo(
    () => images.find((i) => i.id === mainId) ?? images[0],
    [images, mainId],
  );

  useEffect(() => {
    imagesRef.current = images;
    if (images.length === 0) {
      setMainId(null);
      return;
    }
    if (!mainId || !images.some((i) => i.id === mainId)) setMainId(images[0].id);
  }, [images, mainId]);

  useEffect(() => {
    return () => {
      for (const item of imagesRef.current) URL.revokeObjectURL(item.url);
    };
  }, []);

  const addFiles = useCallback((files: File[]) => {
    const next = files
      .filter((f) => f.type.startsWith("image/"))
      .map((file) => ({ id: makeId(), file, url: URL.createObjectURL(file) }));
    if (next.length === 0) return;
    setImages((prev) => [...prev, ...next]);
    setError(null);
  }, []);

  const clearAll = useCallback(() => {
    abortRef.current?.abort();
    setImages((prev) => {
      for (const item of prev) URL.revokeObjectURL(item.url);
      return [];
    });
    setMainId(null);
    setProgress(null);
    setError(null);
  }, []);

  const handleFileInput = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const fileList = e.target.files;
      if (!fileList) return;
      addFiles(Array.from(fileList));
      e.target.value = "";
    },
    [addFiles],
  );

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      addFiles(Array.from(e.dataTransfer.files));
    },
    [addFiles],
  );

  const scaledGap = useCallback(
    (size: number) => Math.max(0, Math.round(gapPxAtExport * (size / exportSize))),
    [gapPxAtExport, exportSize],
  );

  const canGenerate = images.length >= 1 && !!mainItem;
  const canExport = canGenerate && images.length >= 1;

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const generatePreview = useCallback(async () => {
    if (!canGenerate) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    setProgress({ phase: "layout", done: 0, total: 1, message: "准备预览…" });

    try {
      await renderCollageToCanvas({
        canvas,
        images,
        mainId: mainItem.id,
        options: {
          size: previewSize,
          mainRatio,
          gap: scaledGap(previewSize),
          background,
          shuffleOthers,
        },
        signal: controller.signal,
        onProgress: setProgress,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "生成失败");
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [
    background,
    canGenerate,
    images,
    mainItem,
    mainRatio,
    previewSize,
    scaledGap,
    shuffleOthers,
  ]);

  const exportHd = useCallback(async () => {
    if (!canExport) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    setProgress({ phase: "layout", done: 0, total: 1, message: "准备导出…" });

    const exportCanvas = document.createElement("canvas");
    try {
      await renderCollageToCanvas({
        canvas: exportCanvas,
        images,
        mainId: mainItem.id,
        options: {
          size: exportSize,
          mainRatio,
          gap: scaledGap(exportSize),
          background,
          shuffleOthers,
        },
        signal: controller.signal,
        onProgress: setProgress,
      });

      setProgress({ phase: "export", done: 0, total: 1, message: "导出文件…" });
      const blob = await canvasToBlob(
        exportCanvas,
        exportFormat,
        exportFormat === "image/jpeg" ? jpegQuality : undefined,
      );
      const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
      const name = `smartcollage-${safeFilenamePart(mainItem.file.name)}-${exportSize}x${exportSize}-${stamp}.${exportFormat === "image/png" ? "png" : "jpg"}`;
      downloadBlob(blob, name);
      setProgress({ phase: "export", done: 1, total: 1, message: "已开始下载" });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "导出失败");
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [
    background,
    canExport,
    exportFormat,
    exportSize,
    images,
    jpegQuality,
    mainItem,
    mainRatio,
    scaledGap,
    shuffleOthers,
  ]);

  const generateDemo = useCallback(async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    setProgress({ phase: "decode", done: 0, total: 120, message: "生成示例图片…" });

    try {
      const files = await createDemoFiles(
        120,
        (done, total) =>
          setProgress({ phase: "decode", done, total, message: `生成示例图片 ${done}/${total}…` }),
        controller.signal,
      );
      addFiles(files);
      setProgress({ phase: "decode", done: 120, total: 120, message: "示例图片已加入" });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "生成示例失败");
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [addFiles]);

  const progressPercent = progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0;
  const mainAreaPercent = Math.round(mainRatio * mainRatio * 100);

  return (
    <div className="min-h-dvh bg-gradient-to-br from-zinc-50 to-zinc-100 text-zinc-950 dark:from-zinc-950 dark:to-zinc-900 dark:text-zinc-50">
      <header className="border-b border-zinc-200/70 bg-white/60 backdrop-blur dark:border-zinc-800/70 dark:bg-zinc-950/40">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-lg font-semibold tracking-tight">SmartCollage</div>
            <div className="text-sm text-zinc-600 dark:text-zinc-400">
              大规模照片拼图（中心主图 + 环绕网格），导出正方形高清图片
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
              onClick={generateDemo}
              disabled={busy}
            >
              生成示例 120 张
            </button>
            <button
              type="button"
              className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
              onClick={clearAll}
              disabled={busy || images.length === 0}
            >
              清空
            </button>
            <button
              type="button"
              className="rounded-xl bg-zinc-950 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white"
              onClick={busy ? cancel : generatePreview}
              disabled={!busy && !canGenerate}
            >
              {busy ? "取消" : "生成预览"}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6 lg:grid-cols-2">
        <section className="rounded-2xl border border-zinc-200/70 bg-white/70 p-4 shadow-sm backdrop-blur dark:border-zinc-800/70 dark:bg-zinc-950/40">
          <div
            className="rounded-xl border border-dashed border-zinc-300 p-4 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="font-medium text-zinc-900 dark:text-zinc-50">上传图片</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  支持拖拽 / 多选；建议 ≥ 100 张测试大规模场景
                </div>
              </div>
              <label className="inline-flex cursor-pointer items-center justify-center rounded-xl bg-zinc-950 px-3 py-2 text-xs font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white">
                选择文件
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  name="images"
                  className="hidden"
                  onChange={handleFileInput}
                  disabled={busy}
                />
              </label>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              <span className="rounded-full bg-zinc-100 px-2 py-1 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
                共 {images.length} 张
              </span>
              <span className="rounded-full bg-zinc-100 px-2 py-1 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
                总大小 {formatBytes(totalBytes)}
              </span>
              {mainItem ? (
                <span className="rounded-full bg-zinc-100 px-2 py-1 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
                  主图：{mainItem.file.name}
                </span>
              ) : null}
            </div>
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-zinc-200/70 bg-white/60 p-4 dark:border-zinc-800/70 dark:bg-zinc-950/30">
              <div className="text-sm font-medium">主图占比</div>
              <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                主图边长占画布边长：{Math.round(mainRatio * 100)}%（面积约 {mainAreaPercent}%）
              </div>
              <input
                type="range"
                min={0.25}
                max={0.8}
                step={0.01}
                name="mainRatio"
                value={mainRatio}
                onChange={(e) => setMainRatio(Number(e.target.value))}
                className="mt-3 w-full accent-zinc-900 dark:accent-zinc-100"
                disabled={busy}
              />
            </div>

            <div className="rounded-xl border border-zinc-200/70 bg-white/60 p-4 dark:border-zinc-800/70 dark:bg-zinc-950/30">
              <div className="text-sm font-medium">网格间隙</div>
              <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                以导出尺寸为基准：{gapPxAtExport}px
              </div>
              <input
                type="range"
                min={0}
                max={24}
                step={1}
                name="gapPxAtExport"
                value={gapPxAtExport}
                onChange={(e) => setGapPxAtExport(Number(e.target.value))}
                className="mt-3 w-full accent-zinc-900 dark:accent-zinc-100"
                disabled={busy}
              />
            </div>

            <div className="rounded-xl border border-zinc-200/70 bg-white/60 p-4 dark:border-zinc-800/70 dark:bg-zinc-950/30">
              <div className="text-sm font-medium">导出设置</div>
              <div className="mt-3 grid gap-2">
                <label className="flex items-center justify-between gap-3 text-xs text-zinc-600 dark:text-zinc-400">
                  输出尺寸(px)
                  <input
                    type="number"
                    min={512}
                    max={8192}
                    step={256}
                    name="exportSize"
                    value={exportSize}
                    onChange={(e) => setExportSize(clamp(Number(e.target.value), 512, 8192))}
                    className="w-28 rounded-lg border border-zinc-200 bg-white px-2 py-1 text-zinc-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50"
                    disabled={busy}
                  />
                </label>
                <label className="flex items-center justify-between gap-3 text-xs text-zinc-600 dark:text-zinc-400">
                  格式
                  <select
                    value={exportFormat}
                    onChange={(e) => setExportFormat(e.target.value as "image/png" | "image/jpeg")}
                    name="exportFormat"
                    className="w-28 rounded-lg border border-zinc-200 bg-white px-2 py-1 text-zinc-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50"
                    disabled={busy}
                  >
                    <option value="image/png">PNG</option>
                    <option value="image/jpeg">JPEG</option>
                  </select>
                </label>
                {exportFormat === "image/jpeg" ? (
                  <label className="flex items-center justify-between gap-3 text-xs text-zinc-600 dark:text-zinc-400">
                    JPEG 质量
                    <input
                      type="number"
                      min={0.5}
                      max={1}
                      step={0.01}
                      name="jpegQuality"
                      value={jpegQuality}
                      onChange={(e) => setJpegQuality(clamp(Number(e.target.value), 0.5, 1))}
                      className="w-28 rounded-lg border border-zinc-200 bg-white px-2 py-1 text-zinc-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50"
                      disabled={busy}
                    />
                  </label>
                ) : null}
              </div>
            </div>

            <div className="rounded-xl border border-zinc-200/70 bg-white/60 p-4 dark:border-zinc-800/70 dark:bg-zinc-950/30">
              <div className="text-sm font-medium">其他</div>
              <div className="mt-3 grid gap-2">
                <label className="flex items-center justify-between gap-3 text-xs text-zinc-600 dark:text-zinc-400">
                  背景色
                  <input
                    type="color"
                    value={background}
                    onChange={(e) => setBackground(e.target.value)}
                    name="background"
                    className="h-8 w-14 rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
                    disabled={busy}
                  />
                </label>
                <label className="flex items-center justify-between gap-3 text-xs text-zinc-600 dark:text-zinc-400">
                  打乱顺序
                  <input
                    type="checkbox"
                    checked={shuffleOthers}
                    onChange={(e) => setShuffleOthers(e.target.checked)}
                    name="shuffleOthers"
                    className="h-4 w-4 accent-zinc-900 dark:accent-zinc-100"
                    disabled={busy}
                  />
                </label>
                <label className="flex items-center justify-between gap-3 text-xs text-zinc-600 dark:text-zinc-400">
                  预览尺寸(px)
                  <input
                    type="number"
                    min={512}
                    max={2048}
                    step={256}
                    name="previewSize"
                    value={previewSize}
                    onChange={(e) => setPreviewSize(clamp(Number(e.target.value), 512, 2048))}
                    className="w-28 rounded-lg border border-zinc-200 bg-white px-2 py-1 text-zinc-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50"
                    disabled={busy}
                  />
                </label>
              </div>
            </div>
          </div>

          <div className="mt-5">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-xl bg-zinc-950 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white"
                onClick={exportHd}
                disabled={!canExport || busy}
              >
                导出高清
              </button>
              <button
                type="button"
                className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
                onClick={() => {
                  if (!mainItem) return;
                  setMainId(mainItem.id);
                }}
                disabled={!canGenerate || busy}
              >
                重新确认主图
              </button>
            </div>

            {progress ? (
              <div className="mt-3 rounded-xl border border-zinc-200/70 bg-white/60 p-3 text-xs dark:border-zinc-800/70 dark:bg-zinc-950/30">
                <div className="flex items-center justify-between gap-3">
                  <div className="truncate">{progress.message ?? "处理中…"}</div>
                  <div className="tabular-nums text-zinc-600 dark:text-zinc-400">{progressPercent}%</div>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                  <div
                    className="h-2 rounded-full bg-zinc-950 transition-[width] dark:bg-zinc-100"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
              </div>
            ) : null}
            {error ? (
              <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
                {error}
              </div>
            ) : null}
          </div>

          <div className="mt-6">
            <div className="text-sm font-medium">选择主图（点击设置）</div>
            <div className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
              {images.slice(0, 240).map((item) => {
                const selected = item.id === mainItem?.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`relative aspect-square overflow-hidden rounded-lg border ${selected ? "border-zinc-950 ring-2 ring-zinc-950 dark:border-zinc-100 dark:ring-zinc-100" : "border-zinc-200 dark:border-zinc-800"} bg-zinc-100 dark:bg-zinc-900`}
                    onClick={() => setMainId(item.id)}
                    disabled={busy}
                    title={item.file.name}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={item.url}
                      alt={item.file.name}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                    {selected ? (
                      <div className="absolute left-1 top-1 rounded-full bg-zinc-950/90 px-2 py-0.5 text-[10px] font-medium text-white dark:bg-zinc-100/90 dark:text-zinc-950">
                        主图
                      </div>
                    ) : null}
                  </button>
                );
              })}
            </div>
            {images.length > 240 ? (
              <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
                为保证性能，仅展示前 240 张缩略图（已上传 {images.length} 张仍会全部参与生成）
              </div>
            ) : null}
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-200/70 bg-white/70 p-4 shadow-sm backdrop-blur dark:border-zinc-800/70 dark:bg-zinc-950/40">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">预览</div>
              <div className="text-xs text-zinc-600 dark:text-zinc-400">
                预览画布：{previewSize}×{previewSize}px（导出：{exportSize}×{exportSize}px）
              </div>
            </div>
            <div className="text-xs text-zinc-600 dark:text-zinc-400">
              gap: {scaledGap(previewSize)}px
            </div>
          </div>
          <div className="mt-3 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <canvas ref={canvasRef} className="h-auto w-full" />
          </div>
          <div className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">
            绘制策略：所有图片采用「等比填充（cover）」以尽量保留长宽比；必要时会从中心轻微裁切。
          </div>
        </section>
      </main>

      <footer className="border-t border-zinc-200/70 bg-white/40 py-6 text-xs text-zinc-600 dark:border-zinc-800/70 dark:bg-zinc-950/20 dark:text-zinc-400">
        <div className="mx-auto max-w-6xl px-4">
          本项目为纯前端生成（Canvas），适合直接部署到 Vercel 等平台。建议先生成预览，再导出高清。
        </div>
      </footer>
    </div>
  );
}
