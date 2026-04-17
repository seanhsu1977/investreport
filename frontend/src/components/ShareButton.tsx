import { useState, useRef, useEffect } from "react";

interface Props {
  text: string;   // 分享內文
  url?: string;   // 分享連結，預設當前頁
}

const COPY_FIRST_PLATFORMS = new Set<string>();

export default function ShareButton({ text, url }: Props) {
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const shareUrl = url ?? window.location.href;
  const fullText = `${text}\n${shareUrl}`;

  // 點外面關閉
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  };

  // 判斷是否為觸控裝置（手機／平板）
  const isTouchDevice = () =>
    typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

  const handleClick = async () => {
    if (isTouchDevice() && navigator.share) {
      try { await navigator.share({ text: fullText }); } catch {}
      return;
    }
    setOpen((v) => !v);
  };

  const handlePlatformClick = async (key: string, href: string) => {
    setOpen(false);
    if (COPY_FIRST_PLATFORMS.has(key)) {
      // 先把文字複製到剪貼簿，再開分享視窗
      try {
        await navigator.clipboard.writeText(fullText);
        showToast("文字已複製，開啟後請按 ⌘V / Ctrl+V 貼上");
      } catch {}
    }
    window.open(href, "_blank", "noopener,noreferrer");
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(fullText);
    setOpen(false);
    showToast("✓ 已複製到剪貼簿");
  };

  const platforms = [
    {
      key: "threads",
      label: "Threads",
      href: `https://www.threads.net/intent/post?text=${encodeURIComponent(fullText)}`,
    },
    {
      key: "facebook",
      label: "Facebook",
      href: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`,
    },
    {
      key: "line",
      label: "LINE",
      href: `https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(text)}`,
    },
    {
      key: "x",
      label: "X (Twitter)",
      href: `https://twitter.com/intent/tweet?text=${encodeURIComponent(fullText)}`,
    },
  ];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={handleClick}
        title="分享"
        className="flex items-center gap-1 text-xs text-gray-400 hover:text-blue-500 transition"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
        </svg>
        分享
      </button>

      {/* 下拉選單 */}
      {open && (
        <div className="absolute right-0 top-6 z-30 bg-white rounded-xl shadow-xl border border-gray-200 py-1.5 min-w-[200px]">
          {platforms.map((p) => (
            <button
              key={p.key}
              onClick={() => handlePlatformClick(p.key, p.href)}
              className="w-full text-left flex items-center gap-2 px-4 py-2 text-xs text-gray-700 hover:bg-gray-50 transition"
            >
              {p.label}
            </button>
          ))}
          <div className="my-1 border-t border-gray-100" />
          <button
            onClick={handleCopy}
            className="w-full text-left flex items-center gap-2 px-4 py-2 text-xs text-gray-700 hover:bg-gray-50 transition"
          >
            複製文字
          </button>
        </div>
      )}

      {/* Toast 提示 */}
      {toast && (
        <div className="absolute right-0 top-8 z-40 bg-gray-800 text-white text-xs rounded-lg px-3 py-2 whitespace-nowrap shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
