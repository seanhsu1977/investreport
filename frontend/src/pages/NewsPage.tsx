import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

interface NewsItem {
  id: string;
  category: string;
  title: string;
  summary: string;
  link: string;
  source: string;
  date: string;
  stocks: string | null;
  img: string;
  click: number;
}

function relTime(dateStr: string) {
  const diff = Date.now() - new Date(dateStr.replace(" ", "T")).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return "剛剛";
  if (mins < 60) return `${mins} 分鐘前`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h} 小時前`;
  return `${Math.floor(h / 24)} 天前`;
}

function parseCodes(stocks: string | null): string[] {
  if (!stocks) return [];
  return stocks.split(",").map(s => s.replace(/\(TW\)/gi, "").trim()).filter(Boolean);
}

const CAT_STYLE: Record<string, { bg: string; color: string }> = {
  "股市":     { bg: "#EFF6FF", color: "#1D4ED8" },
  "股市評論": { bg: "#EFF6FF", color: "#1D4ED8" },
  "公司動態": { bg: "#ECFDF5", color: "#065F46" },
  "財經評論": { bg: "#F1F5F9", color: "#475569" },
  "國際新聞": { bg: "#FFF7ED", color: "#C2410C" },
  "大陸新聞": { bg: "#FFF7ED", color: "#C2410C" },
  "貿易":     { bg: "#F1F5F9", color: "#475569" },
  "Ptt股市":  { bg: "#F5F3FF", color: "#6D28D9" },
};
function catStyle(cat: string) {
  return CAT_STYLE[cat] ?? { bg: "#F1F5F9", color: "#475569" };
}

function AnalysisText({ text }: { text: string }) {
  return (
    <div style={{ fontSize: 13.5, lineHeight: 1.7, color: "rgba(15,23,42,0.82)" }}>
      {text.split("\n").map((line, i) => {
        if (line.startsWith("## ")) {
          return <div key={i} style={{ fontWeight: 600, fontSize: 13, color: "#0F172A", marginTop: 14, marginBottom: 4 }}>{line.slice(3)}</div>;
        }
        if (line.startsWith("- ")) {
          return (
            <div key={i} style={{ display: "flex", gap: 6, marginBottom: 3 }}>
              <span style={{ color: "#6366F1", flexShrink: 0, marginTop: 2 }}>•</span>
              <span>{line.slice(2)}</span>
            </div>
          );
        }
        if (line.startsWith("強勢：")) {
          return <div key={i} style={{ marginBottom: 3 }}><span style={{ fontWeight: 600, color: "#059669" }}>強勢：</span>{line.slice(3)}</div>;
        }
        if (line.startsWith("弱勢：")) {
          return <div key={i} style={{ marginBottom: 3 }}><span style={{ fontWeight: 600, color: "#EA580C" }}>弱勢：</span>{line.slice(3)}</div>;
        }
        if (!line.trim()) return <div key={i} style={{ height: 4 }} />;
        return <div key={i} style={{ marginBottom: 3 }}>{line}</div>;
      })}
    </div>
  );
}

const ALL_CATS = ["全部", "股市評論", "股市", "公司動態", "國際新聞", "Ptt股市", "財經評論"];

export default function NewsPage() {
  const [news, setNews] = useState<NewsItem[]>([]);
  const [newsLoading, setNewsLoading] = useState(true);
  const [cat, setCat] = useState("全部");

  const [analysis, setAnalysis] = useState("");
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState("");

  const loadAnalysis = async (refresh = false) => {
    setAnalysisLoading(true);
    setAnalysis("");
    setAnalysisError("");
    try {
      const token = localStorage.getItem("auth_token");
      const resp = await fetch(`/api/news/market-analysis${refresh ? "?refresh=true" : ""}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          if (payload === "[DONE]") continue;
          try {
            const obj = JSON.parse(payload);
            if (obj.text) setAnalysis(prev => prev + obj.text);
            if (obj.error) setAnalysisError(obj.error);
          } catch {/* ignore */}
        }
      }
    } catch (e: unknown) {
      setAnalysisError(String(e));
    } finally {
      setAnalysisLoading(false);
    }
  };

  useEffect(() => {
    fetch("/api/news/list")
      .then(r => r.json())
      .then(d => setNews(d.data ?? []))
      .catch(() => {})
      .finally(() => setNewsLoading(false));

    loadAnalysis();
  }, []);

  const filtered = cat === "全部" ? news : news.filter(n => n.category === cat);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 flex flex-col gap-5">

      {/* Header */}
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">市場快訊</h1>
          <p className="text-sm mt-0.5" style={{ color: "rgba(15,23,42,0.4)" }}>nstock 即時財經新聞 · AI 盤勢分析</p>
        </div>
      </div>

      {/* AI Analysis Panel */}
      <div className="rounded-2xl overflow-hidden" style={{ border: "1.5px solid #94A3B8", background: "#F1F5F9", boxShadow: "0 2px 12px rgba(0,0,0,0.08)" }}>
        <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: "1px solid #CBD5E1", background: "white" }}>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold px-2 py-0.5 rounded-md" style={{ background: "#EEF2FF", color: "#6366F1" }}>AI</span>
            <span className="text-sm font-semibold" style={{ color: "#0F172A" }}>今日盤勢分析</span>
          </div>
          <button
            onClick={() => loadAnalysis(true)}
            disabled={analysisLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition"
            style={{ background: "#F8FAFC", border: "1px solid #CBD5E1", color: analysisLoading ? "#94A3B8" : "#475569", cursor: analysisLoading ? "not-allowed" : "pointer" }}>
            {analysisLoading ? "分析中…" : "重新生成"}
          </button>
        </div>
        <div className="px-5 py-4" style={{ minHeight: 80 }}>
          {analysisLoading && !analysis && (
            <div className="flex items-center gap-2 text-sm" style={{ color: "#94A3B8" }}>
              <span style={{ animation: "pulse 1.5s ease-in-out infinite" }}>●</span>
              正在分析今日財經新聞…
            </div>
          )}
          {analysisError && (
            <div className="text-sm" style={{ color: "#EA580C" }}>分析失敗：{analysisError}</div>
          )}
          {analysis && <AnalysisText text={analysis} />}
          {analysisLoading && analysis && (
            <span style={{ color: "#6366F1", animation: "blink 1s step-end infinite" }}>▌</span>
          )}
        </div>
      </div>

      {/* Category filter */}
      <div className="flex gap-2 flex-wrap">
        {ALL_CATS.map(c => (
          <button key={c} onClick={() => setCat(c)}
            className="px-3 py-1.5 rounded-lg text-sm transition"
            style={{
              background: cat === c ? "#0F172A" : "white",
              color: cat === c ? "white" : "#64748B",
              border: `1.5px solid ${cat === c ? "#0F172A" : "#CBD5E1"}`,
              fontWeight: cat === c ? 600 : 400,
            }}>
            {c}
          </button>
        ))}
        <button onClick={() => {
          setNewsLoading(true);
          fetch("/api/news/list").then(r => r.json()).then(d => setNews(d.data ?? [])).finally(() => setNewsLoading(false));
        }} className="ml-auto px-3 py-1.5 rounded-lg text-sm transition"
          style={{ background: "white", color: "#64748B", border: "1px solid #CBD5E1" }}>
          重整
        </button>
      </div>

      {/* News list */}
      {newsLoading ? (
        <div className="text-center py-12 text-sm" style={{ color: "#94A3B8" }}>載入新聞中…</div>
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map(item => {
            const codes = parseCodes(item.stocks);
            const cs = catStyle(item.category);
            return (
              <a key={item.id} href={item.link} target="_blank" rel="noopener noreferrer"
                className="flex gap-3 rounded-2xl p-4 transition"
                style={{ background: "white", border: "1px solid #E2E8F0", textDecoration: "none", display: "flex" }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = "#94A3B8")}
                onMouseLeave={e => (e.currentTarget.style.borderColor = "#E2E8F0")}>
                {item.img && (
                  <img src={item.img} alt=""
                    style={{ width: 64, height: 64, borderRadius: 10, objectFit: "cover", flexShrink: 0, background: "#E2E8F0" }}
                    onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 6px", borderRadius: 4, background: cs.bg, color: cs.color }}>{item.category}</span>
                    <span style={{ fontSize: 11, color: "#94A3B8" }}>{item.source}</span>
                    <span style={{ fontSize: 11, color: "#CBD5E1" }}>·</span>
                    <span style={{ fontSize: 11, color: "#94A3B8" }}>{relTime(item.date)}</span>
                  </div>
                  <div style={{ fontSize: 13.5, fontWeight: 500, lineHeight: 1.5, color: "#0F172A", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                    {item.title}
                  </div>
                  {codes.length > 0 && (
                    <div style={{ display: "flex", gap: 5, marginTop: 7, flexWrap: "wrap" }} onClick={e => e.preventDefault()}>
                      {codes.slice(0, 6).map(code => (
                        <Link key={code} to={`/stocks/${code}`}
                          style={{ fontSize: 11, fontWeight: 600, padding: "2px 6px", borderRadius: 4, background: "#ECFDF5", color: "#059669", textDecoration: "none" }}>
                          {code}
                        </Link>
                      ))}
                      {codes.length > 6 && (
                        <span style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4, background: "#F1F5F9", color: "#94A3B8" }}>+{codes.length - 6}</span>
                      )}
                    </div>
                  )}
                </div>
              </a>
            );
          })}
          {filtered.length === 0 && (
            <div className="text-center py-12 text-sm" style={{ color: "#94A3B8" }}>此分類目前無新聞</div>
          )}
        </div>
      )}

      <style>{`
        @keyframes blink { 50% { opacity: 0; } }
      `}</style>
    </div>
  );
}
