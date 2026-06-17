import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import { Navigate, useLocation } from "react-router-dom";
import { usePostMaterials } from "../hooks/usePostMaterials";
import { syncApi, type SyncLogEntry } from "../api/client";

interface UserRecord {
  id: number;
  email: string;
  name: string;
  picture: string;
  is_admin: boolean;
  created_at: string;
  last_login: string;
  login_count: number;
}

interface Session {
  id: number;
  logged_in_at: string;
  ip_address: string | null;
  user_agent: string | null;
}

interface ReportItem {
  id: number;
  stock_code: string;
  stock_name: string;
  recommendation: string;
  target_price: string;
  analyst: string;
  report_date: string;
  summary: string;
}

// ── 每日草稿區塊（00981A × 投顧報告 自動生成） ────────────────
interface DailyDraftSummary {
  id: number;
  date: string;
  topic_stock_code: string;
  topic_stock_name: string | null;
  title: string;
  generated_at: string;
  published_at: string | null;          // nStock 送出時間
  nstock_article_id: number | null;
  edit_url: string | null;
  threads_post_id: string | null;
  threads_posted_at: string | null;
  fb_post_id: string | null;
  fb_posted_at: string | null;
  fb_url: string | null;
  preview?: string;
}

interface DailyDraftDetail extends DailyDraftSummary {
  content: string;
  source_links?: { label: string; url: string }[];
}

function DailySection({ token }: { token: string }) {
  const headers = { Authorization: `Bearer ${token}` };
  const [list, setList] = useState<DailyDraftSummary[]>([]);
  const [active, setActive] = useState<DailyDraftDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishLive, setPublishLive] = useState(false);  // 預設送 nStock 草稿區不上架
  const [nstockAuthName, setNstockAuthName] = useState("");
  const [nstockImgPath, setNstockImgPath] = useState("");
  const [postingThreads, setPostingThreads] = useState(false);
  const [threadsTag, setThreadsTag] = useState("");
  const [postingFb, setPostingFb] = useState(false);
  const [fbWithLink, setFbWithLink] = useState(true);
  const [fbSummaryOnly, setFbSummaryOnly] = useState(true);
  const [fbPicture, setFbPicture] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const refreshList = async () => {
    setLoading(true);
    try {
      const r = await axios.get<DailyDraftSummary[]>("/api/publish/daily", { headers });
      setList(r.data);
    } finally {
      setLoading(false);
    }
  };

  const openDraft = async (id: number) => {
    setMsg(null);
    const r = await axios.get<DailyDraftDetail>(`/api/publish/daily/${id}`, { headers });
    setActive(r.data);
  };

  useEffect(() => { refreshList(); }, []);

  const [generateDate, setGenerateDate] = useState("");  // "" = 今日

  const generateToday = async () => {
    setMsg(null);
    setGenerating(true);
    try {
      const params: Record<string, string | boolean> = { force: true };
      if (generateDate) params.date = generateDate;
      const r = await axios.post<DailyDraftDetail>(
        "/api/publish/daily/refresh", null, { headers, params, timeout: 120000 }
      );
      setActive(r.data);
      await refreshList();
      setMsg({ ok: true, text: `✅ 生成完成：${r.data.title}` });
    } catch (e: any) {
      const status = e.response?.status;
      const ct = e.response?.headers?.["content-type"] ?? "";
      let detail = "生成失敗";
      if (e.response?.data) {
        if (ct.includes("json") || typeof e.response.data === "object") {
          detail = e.response.data?.detail ?? JSON.stringify(e.response.data).slice(0, 200);
        } else if (typeof e.response.data === "string" && !e.response.data.startsWith("<")) {
          detail = e.response.data.slice(0, 200);
        } else if (status) {
          detail = `HTTP ${status}`;
        }
      } else if (e.code === "ECONNABORTED" || e.message?.includes("timeout")) {
        detail = "請求逾時（Gemini 回應太慢），請稍後再試";
      }
      setMsg({ ok: false, text: `❌ ${detail}` });
    } finally {
      setGenerating(false);
    }
  };

  const saveDraft = async () => {
    if (!active) return;
    setSaving(true);
    setMsg(null);
    try {
      const r = await axios.patch<DailyDraftDetail>(
        `/api/publish/daily/${active.id}`,
        { title: active.title, content: active.content },
        { headers }
      );
      setActive(r.data);
      await refreshList();
      setMsg({ ok: true, text: "✅ 已儲存" });
    } catch (e: any) {
      setMsg({ ok: false, text: `❌ ${e.response?.data?.detail ?? "儲存失敗"}` });
    } finally {
      setSaving(false);
    }
  };

  const publishToNstock = async () => {
    if (!active) return;
    const action = publishLive ? "直接上架" : "送到 nStock 草稿區（不上架）";
    const repostHint = active.published_at
      ? "\n\n⚠️ 此草稿之前已送出過，再送會在 nStock 產生第二篇文章。"
      : "";
    if (!confirm(`確定要 ${action}「${active.title}」？${repostHint}`)) return;
    setPublishing(true);
    setMsg(null);
    try {
      // 先 auto-save，避免使用者修改標題/內文未存就送出（後端從 DB 讀）
      await axios.patch(
        `/api/publish/daily/${active.id}`,
        { title: active.title, content: active.content },
        { headers }
      );
      const nstockParams: Record<string, string | boolean> = { live: publishLive };
      if (nstockAuthName.trim()) nstockParams.auth_name = nstockAuthName.trim();
      if (nstockImgPath.trim()) nstockParams.img_path = nstockImgPath.trim();
      const r = await axios.post(
        `/api/publish/daily/${active.id}/publish-nstock`, null,
        { headers, params: nstockParams }
      );
      const aid = r.data?.article_id;
      if (aid) {
        const statusHint = publishLive ? "已上架" : "存於 nStock 後台草稿區";
        setMsg({ ok: true, text: `✅ ${statusHint}：article_id ${aid}` });
        await openDraft(active.id);
        await refreshList();
      } else {
        setMsg({ ok: false, text: "⚠️ 回 200 但抓不到 article_id" });
      }
    } catch (e: any) {
      setMsg({ ok: false, text: `❌ ${e.response?.data?.detail ?? "發送失敗"}` });
    } finally {
      setPublishing(false);
    }
  };

  const publishToThreads = async () => {
    if (!active) return;
    const repostHint = active.threads_post_id
      ? "\n\n⚠️ 此草稿之前已發過 Threads，再發會產生第二串。"
      : "";
    if (!confirm(`確定要發到 Threads？（會自動切段成留言鏈，粗體 ** 會被剝掉）${repostHint}`)) return;
    setPostingThreads(true);
    setMsg(null);
    try {
      // 一樣先 auto-save
      await axios.patch(
        `/api/publish/daily/${active.id}`,
        { title: active.title, content: active.content },
        { headers }
      );
      const r = await axios.post(
        `/api/publish/daily/${active.id}/publish-threads`, null,
        { headers, params: threadsTag.trim() ? { topic_tag: threadsTag.trim() } : {} }
      );
      const pid = r.data?.post_id;
      const segs = r.data?.segments ?? 1;
      if (pid) {
        const chainHint = segs > 1 ? `（${segs} 段留言鏈）` : "";
        setMsg({ ok: true, text: `✅ Threads ${chainHint}：${pid}` });
        await openDraft(active.id);
        await refreshList();
      } else {
        setMsg({ ok: false, text: "⚠️ 回 200 但抓不到 post_id" });
      }
    } catch (e: any) {
      setMsg({ ok: false, text: `❌ ${e.response?.data?.detail ?? "Threads 發送失敗"}` });
    } finally {
      setPostingThreads(false);
    }
  };

  const publishToFacebook = async () => {
    if (!active) return;
    const repostHint = active.fb_post_id
      ? "\n\n⚠️ 此草稿之前已發過 FB，再發會在粉專產生第二篇貼文。"
      : "";
    const linkHint = fbWithLink && active.nstock_article_id
      ? "\n\n（會帶 nStock 文章連結，FB 會生 link card）"
      : (fbWithLink && !active.nstock_article_id
        ? "\n\n（勾了帶 nStock 連結但 nStock 還沒發過，這次會純文字）"
        : "");
    if (!confirm(`確定要發到 Facebook 粉專？${linkHint}${repostHint}`)) return;
    setPostingFb(true);
    setMsg(null);
    try {
      await axios.patch(
        `/api/publish/daily/${active.id}`,
        { title: active.title, content: active.content },
        { headers }
      );
      const fbParams: Record<string, string | boolean> = {
        with_nstock_link: fbWithLink,
        summary_only: fbSummaryOnly,
      };
      if (fbPicture.trim()) fbParams.picture = fbPicture.trim();
      const r = await axios.post(
        `/api/publish/daily/${active.id}/publish-facebook`, null,
        { headers, params: fbParams }
      );
      const pid = r.data?.post_id;
      if (pid) {
        setMsg({ ok: true, text: `✅ FB 已發布：${pid}` });
        await openDraft(active.id);
        await refreshList();
      } else {
        setMsg({ ok: false, text: "⚠️ 回 200 但抓不到 post_id" });
      }
    } catch (e: any) {
      setMsg({ ok: false, text: `❌ ${e.response?.data?.detail ?? "FB 發送失敗"}` });
    } finally {
      setPostingFb(false);
    }
  };

  const fmtDateTime = (s: string | null) => s ? s.replace("T", " ").slice(0, 16) : "—";

  return (
    <div className="space-y-4">
      {/* 操作列 */}
      <section className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-3 flex-wrap">
        <p className="text-sm text-gray-600 flex-1">
          每天 19:45 自動抓 ETF 小百科 00981A 操作，挑一檔有投顧報告的個股寫成 Newtalk 風格議論文。
        </p>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={generateDate}
            onChange={(e) => setGenerateDate(e.target.value)}
            className="text-sm px-2 py-1.5 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
          <button
            onClick={generateToday}
            disabled={generating}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-40 transition"
          >
            {generating ? "生成中…" : generateDate ? `生成 ${generateDate} 草稿` : "立即生成今日草稿"}
          </button>
        </div>
      </section>

      {msg && (
        <div className={`rounded-lg px-4 py-2 text-sm ${
          msg.ok ? "bg-green-50 text-green-700 border border-green-200"
                 : "bg-red-50 text-red-700 border border-red-200"
        }`}>{msg.text}</div>
      )}

      {/* 草稿清單 */}
      <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-semibold text-gray-700">草稿列表</h2>
          <span className="text-sm text-gray-400">{list.length} 篇</span>
        </div>
        {loading ? (
          <p className="px-5 py-8 text-center text-gray-400 text-sm">載入中…</p>
        ) : list.length === 0 ? (
          <p className="px-5 py-8 text-center text-gray-400 text-sm">尚無草稿</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr>
                <th className="px-4 py-2 text-left">日期</th>
                <th className="px-4 py-2 text-left">主題</th>
                <th className="px-4 py-2 text-left">標題</th>
                <th className="px-4 py-2 text-left">狀態</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {list.map((d) => (
                <tr
                  key={d.id}
                  onClick={() => openDraft(d.id)}
                  className={`hover:bg-blue-50 cursor-pointer transition ${
                    active?.id === d.id ? "bg-blue-50" : ""
                  }`}
                >
                  <td className="px-4 py-2 text-gray-700 tabular-nums">{d.date}</td>
                  <td className="px-4 py-2 text-gray-700">
                    <span className="font-mono text-blue-700">{d.topic_stock_code}</span>
                    {d.topic_stock_name && <span className="ml-1 text-xs text-gray-500">{d.topic_stock_name}</span>}
                  </td>
                  <td className="px-4 py-2 text-gray-700 truncate max-w-md" title={d.title}>{d.title}</td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap gap-1">
                      {d.published_at ? (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-green-50 text-green-700 border border-green-200" title={`nStock ${fmtDateTime(d.published_at)}`}>nStock</span>
                      ) : null}
                      {d.threads_post_id ? (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200" title={`Threads ${fmtDateTime(d.threads_posted_at)}`}>Threads</span>
                      ) : null}
                      {d.fb_post_id ? (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200" title={`FB ${fmtDateTime(d.fb_posted_at)}`}>FB</span>
                      ) : null}
                      {!d.published_at && !d.threads_post_id && !d.fb_post_id && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">草稿</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right">
                    {d.edit_url && (
                      <a href={d.edit_url} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}
                        className="text-xs text-blue-600 hover:underline">nStock ↗</a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* 編輯 / 發布 */}
      {active && (
        <section className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h2 className="font-semibold text-gray-700">編輯草稿 — {active.date}</h2>
            <button
              onClick={saveDraft}
              disabled={saving}
              className="bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-40 transition"
            >
              {saving ? "儲存中…" : "儲存"}
            </button>
          </div>

          <input
            type="text"
            value={active.title}
            onChange={(e) => setActive({ ...active, title: e.target.value })}
            className="w-full text-lg font-semibold border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-400"
          />

          {/* 資料來源連結 */}
          {active.source_links && active.source_links.length > 0 && (
            <div className="flex flex-wrap gap-2 py-1">
              <span className="text-xs text-gray-400 self-center">資料來源：</span>
              {active.source_links.map((l) => (
                <a
                  key={l.url}
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs px-2.5 py-1 rounded-full bg-blue-50 text-blue-600 hover:bg-blue-100 border border-blue-200 transition"
                >
                  {l.label} ↗
                </a>
              ))}
            </div>
          )}

          <textarea
            value={active.content}
            onChange={(e) => setActive({ ...active, content: e.target.value })}
            rows={24}
            className="w-full font-mono text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-400 leading-relaxed"
          />
          <p className="text-xs text-gray-400">
            字數 {active.content.length} ｜ 主題：{active.topic_stock_code} {active.topic_stock_name} ｜ 生成時間 {fmtDateTime(active.generated_at)}
          </p>

          {/* 發送區：nStock + Threads + Facebook */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-3 border-t border-gray-100">
            {/* nStock */}
            <div className="border border-gray-200 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-gray-700">nStock</span>
                {active.published_at && (
                  <span className="text-xs text-gray-400">已送 {fmtDateTime(active.published_at)}</span>
                )}
              </div>
              <input
                type="text"
                value={nstockAuthName}
                onChange={(e) => setNstockAuthName(e.target.value)}
                placeholder="作者名稱（留空=用環境變數預設值）"
                className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
              <input
                type="text"
                value={nstockImgPath}
                onChange={(e) => setNstockImgPath(e.target.value)}
                placeholder="封面圖片路徑（留空=用環境變數預設值）"
                className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
              <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={publishLive}
                  onChange={(e) => setPublishLive(e.target.checked)}
                  className="accent-red-500"
                />
                直接上架（預設只送草稿區）
              </label>
              <button
                onClick={publishToNstock}
                disabled={publishing}
                className={`w-full text-white px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-40 transition ${
                  publishLive ? "bg-red-600 hover:bg-red-700" : "bg-blue-600 hover:bg-blue-700"
                }`}
              >
                {publishing ? "送出中…"
                  : publishLive
                    ? (active.published_at ? "再送一次（並上架）" : "送到 nStock 並上架")
                    : (active.published_at ? "再送一次（草稿）" : "送到 nStock 草稿區")}
              </button>
            </div>

            {/* Threads */}
            <div className="border border-gray-200 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-gray-700">Threads</span>
                {active.threads_post_id && (
                  <span className="text-xs text-gray-400">已發 {fmtDateTime(active.threads_posted_at)}</span>
                )}
              </div>
              <input
                type="text"
                value={threadsTag}
                onChange={(e) => setThreadsTag(e.target.value)}
                placeholder="主題標籤 (選填，例：#台股)"
                className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-purple-400"
              />
              <button
                onClick={publishToThreads}
                disabled={postingThreads}
                className="w-full bg-purple-600 hover:bg-purple-700 text-white px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-40 transition"
              >
                {postingThreads ? "發布中…"
                  : active.threads_post_id ? "再發一次到 Threads" : "送到 Threads"}
              </button>
            </div>

            {/* Facebook */}
            <div className="border border-gray-200 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-gray-700">Facebook</span>
                {active.fb_post_id && (
                  <a href={active.fb_url ?? "#"} target="_blank" rel="noopener"
                    className="text-xs text-blue-600 hover:underline">
                    已發 {fmtDateTime(active.fb_posted_at)} ↗
                  </a>
                )}
              </div>
              <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={fbSummaryOnly}
                  onChange={(e) => setFbSummaryOnly(e.target.checked)}
                  className="accent-blue-500"
                />
                只發摘要（首段 + link card，FB 觸及較好）
              </label>
              <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={fbWithLink}
                  onChange={(e) => setFbWithLink(e.target.checked)}
                  className="accent-blue-500"
                />
                帶 nStock 連結（生 link card）
              </label>
              <input
                type="url"
                value={fbPicture}
                onChange={(e) => setFbPicture(e.target.value)}
                placeholder="縮圖 URL（選填，貼圖片網址可覆蓋 nStock logo）"
                className="w-full text-xs px-2 py-1.5 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-300"
              />
              <button
                onClick={publishToFacebook}
                disabled={postingFb}
                className="w-full bg-blue-700 hover:bg-blue-800 text-white px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-40 transition"
              >
                {postingFb ? "發布中…"
                  : active.fb_post_id ? "再發一次到 FB" : "送到 Facebook"}
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}


// ── 社群發布區塊 ─────────────────────────────────────────
function PublishSection({ token, initialIds }: { token: string; initialIds?: number[] }) {
  const headers = { Authorization: `Bearer ${token}` };
  const materials = usePostMaterials();
  const [reports, setReports] = useState<ReportItem[]>([]);
  // 從 location.state 進來（initialIds）為主，否則沿用全域素材（跨個股累積後直接導入）
  const [selected, setSelected] = useState<Set<number>>(() =>
    new Set(initialIds && initialIds.length > 0 ? initialIds : materials.ids)
  );
  const [hint, setHint] = useState("");
  const [draft, setDraft] = useState("");
  const [topicTag, setTopicTag] = useState("");
  const [nstockTitle, setNstockTitle] = useState("");
  const [alsoThreads, setAlsoThreads] = useState(true);
  const [alsoNstock, setAlsoNstock] = useState(true);
  const [alsoFb, setAlsoFb] = useState(false);
  const [fbLink, setFbLink] = useState("");
  const [fbPic, setFbPic] = useState("");
  const [generating, setGenerating] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 篩選狀態
  const [search, setSearch] = useState("");
  const [recFilter, setRecFilter] = useState<string>("全部");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  useEffect(() => {
    axios.get("/api/publish/reports?limit=100", { headers }).then((r) => setReports(r.data));
  }, []);

  const REC_OPTIONS = ["全部", "買進", "增持", "持有", "中立", "減持", "賣出"];

  const filtered = reports.filter((r) => {
    if (search) {
      const q = search.toLowerCase();
      if (!r.stock_code.includes(q) && !r.stock_name?.toLowerCase().includes(q) && !r.analyst?.toLowerCase().includes(q))
        return false;
    }
    if (recFilter !== "全部" && r.recommendation !== recFilter) return false;
    if (dateFrom && r.report_date < dateFrom) return false;
    if (dateTo && r.report_date > dateTo) return false;
    return true;
  });

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const generateDraft = async () => {
    if (selected.size === 0) return;
    setDraft("");
    setPublishResult(null);
    setGenerating(true);

    const resp = await fetch("/api/publish/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ report_ids: [...selected], hint }),
    });

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let content = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") break;
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) { content = `⚠️ ${parsed.error}`; break; }
          content += parsed.text ?? "";
          setDraft(content);
          bottomRef.current?.scrollIntoView({ behavior: "smooth" });
        } catch {}
      }
    }
    setGenerating(false);
  };

  const publish = async () => {
    if (!draft.trim()) return;
    if (alsoNstock && !nstockTitle.trim()) {
      setPublishResult({ ok: false, msg: "請輸入 nStock 標題（或取消勾選同時發布）" });
      return;
    }
    setPublishing(true);
    setPublishResult(null);

    const messages: string[] = [];
    let anyFail = false;

    // 1. Threads
    if (alsoThreads) {
      try {
        const payload: { text: string; topic_tag?: string } = { text: draft };
        const tag = topicTag.trim();
        if (tag) payload.topic_tag = tag;
        const r = await axios.post("/api/publish/threads", payload, { headers });
        const segs = r.data.segments ?? 1;
        const chainHint = segs > 1 ? `（${segs} 段留言鏈）` : "";
        messages.push(`✅ Threads ${chainHint}：${r.data.post_id}`);
      } catch (e: any) {
        anyFail = true;
        const detail = e.response?.data?.detail ?? "發布失敗";
        messages.push(`❌ Threads：${detail}`);
      }
    }

    // 2. nStock（同時發布）
    let nstockArticleId: number | null = null;
    if (alsoNstock) {
      try {
        const r = await axios.post(
          "/api/publish/nstock",
          { title: nstockTitle.trim(), content: draft },
          { headers }
        );
        const aid = r.data.article_id;
        const sids = r.data.stock_ids;
        const stockHint = sids ? `（相關股號 ${sids}）` : "";
        if (aid) {
          nstockArticleId = aid;
          messages.push(`✅ nStock：article_id ${aid}${stockHint}`);
        } else {
          const rawPreview = JSON.stringify(r.data.raw ?? r.data).slice(0, 120);
          messages.push(`⚠️ nStock 回 200 但抓不到 article_id${stockHint}（raw: ${rawPreview}…）`);
        }
      } catch (e: any) {
        anyFail = true;
        const detail = e.response?.data?.detail ?? "發布失敗";
        messages.push(`❌ nStock：${detail}`);
      }
    }

    // 3. Facebook（同時發布）
    if (alsoFb) {
      try {
        const link = fbLink.trim()
          || (nstockArticleId ? `https://www.nstock.tw/author/article?id=${nstockArticleId}` : undefined);
        const r = await axios.post(
          "/api/publish/facebook",
          { text: draft, ...(link ? { link } : {}), ...(fbPic.trim() ? { picture: fbPic.trim() } : {}) },
          { headers }
        );
        const pid = r.data.post_id;
        if (pid) {
          const linkHint = link ? "（含 link card）" : "";
          messages.push(`✅ FB：${pid}${linkHint}`);
        } else {
          messages.push("⚠️ FB 回 200 但抓不到 post_id");
        }
      } catch (e: any) {
        anyFail = true;
        const detail = e.response?.data?.detail ?? "發布失敗";
        messages.push(`❌ FB：${detail}`);
      }
    }

    setPublishResult({ ok: !anyFail, msg: messages.join("　|　") });
    // 全部成功才清空素材，部份失敗保留以便重試
    if (!anyFail) materials.clear();
    setPublishing(false);
  };

  const recColor: Record<string, string> = {
    買進: "bg-green-100 text-green-700",
    增持: "bg-green-100 text-green-700",
    持有: "bg-yellow-100 text-yellow-700",
    中立: "bg-yellow-100 text-yellow-700",
    賣出: "bg-red-100 text-red-700",
    減持: "bg-red-100 text-red-700",
  };

  return (
    <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100">
        <h2 className="font-semibold text-gray-700">社群發布</h2>
        <p className="text-xs text-gray-400 mt-0.5">選擇報告 → 生成草稿 → 發布到 Threads</p>
      </div>

      <div className="p-5 grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* 左：報告選擇 */}
        <div className="space-y-3">
          <p className="text-sm font-medium text-gray-600">選擇報告（可多選）</p>

          {/* 篩選列 */}
          <div className="space-y-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜尋股票代號、名稱、分析師…"
              className="w-full text-sm px-3 py-1.5 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-300"
            />
            <div className="flex gap-1 flex-wrap">
              {REC_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  onClick={() => setRecFilter(opt)}
                  className={`text-xs px-2 py-0.5 rounded-full border transition ${
                    recFilter === opt
                      ? "bg-blue-600 text-white border-blue-600"
                      : "bg-white text-gray-500 border-gray-200 hover:border-gray-400"
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
            <div className="flex gap-2 items-center text-xs text-gray-500">
              <span>日期</span>
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
                className="text-xs px-2 py-1 rounded border border-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-300" />
              <span>—</span>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
                className="text-xs px-2 py-1 rounded border border-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-300" />
              {(search || recFilter !== "全部" || dateFrom || dateTo) && (
                <button onClick={() => { setSearch(""); setRecFilter("全部"); setDateFrom(""); setDateTo(""); }}
                  className="text-blue-500 hover:underline ml-1">清除</button>
              )}
            </div>
            <p className="text-xs text-gray-400">共 {filtered.length} 筆</p>
          </div>

          <div className="max-h-64 overflow-y-auto space-y-1.5 pr-1">
            {filtered.map((r) => {
              const active = selected.has(r.id);
              return (
                <div
                  key={r.id}
                  className={`flex items-start gap-3 p-2.5 rounded-lg border transition ${
                    active ? "border-blue-400 bg-blue-50" : "border-gray-100 hover:border-gray-300"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={active}
                    onChange={() => toggle(r.id)}
                    className="mt-1 accent-blue-600 shrink-0 cursor-pointer"
                  />
                  <div className="min-w-0 flex-1 cursor-pointer" onClick={() => toggle(r.id)}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-gray-800 text-sm">{r.stock_code} {r.stock_name}</span>
                      {r.recommendation && (
                        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${recColor[r.recommendation] ?? "bg-gray-100 text-gray-500"}`}>
                          {r.recommendation}
                        </span>
                      )}
                      {r.target_price && (
                        <span className="text-xs text-gray-400">目標 {r.target_price}</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">{r.analyst} · {r.report_date}</p>
                  </div>
                </div>
              );
            })}
          </div>

          <div>
            <label className="text-xs font-medium text-gray-500 block mb-1">補充方向（選填）</label>
            <input
              type="text"
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              placeholder="例：著重 AI 題材、適合保守型投資人…"
              className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-300"
            />
          </div>

          <button
            onClick={generateDraft}
            disabled={selected.size === 0 || generating}
            className="w-full py-2 bg-blue-600 text-white text-sm rounded-lg font-medium hover:bg-blue-700 disabled:opacity-40 transition"
          >
            {generating ? "生成中…" : `生成草稿（已選 ${selected.size} 篇）`}
          </button>
        </div>

        {/* 右：草稿編輯 + 發布 */}
        <div className="space-y-3 flex flex-col">
          <p className="text-sm font-medium text-gray-600">貼文草稿</p>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="草稿將在這裡顯示，可直接編輯…"
            rows={10}
            className="flex-1 w-full text-sm px-3 py-2 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-300 resize-none font-sans leading-relaxed"
          />
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 shrink-0 text-xs text-gray-600 select-none">
              <input
                type="checkbox"
                checked={alsoThreads}
                onChange={(e) => setAlsoThreads(e.target.checked)}
                className="accent-black"
              />
              發布 Threads
            </label>
            <input
              type="text"
              value={topicTag}
              onChange={(e) => setTopicTag(e.target.value)}
              disabled={!alsoThreads}
              placeholder={alsoThreads ? "Threads 主題標籤（可留空）" : "已停用"}
              className="flex-1 text-sm px-3 py-1.5 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:bg-gray-50 disabled:text-gray-400"
            />
          </div>

          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 shrink-0 text-xs text-gray-600 select-none">
              <input
                type="checkbox"
                checked={alsoNstock}
                onChange={(e) => setAlsoNstock(e.target.checked)}
                className="accent-blue-500"
              />
              同步 nStock
            </label>
            <input
              type="text"
              value={nstockTitle}
              onChange={(e) => setNstockTitle(e.target.value)}
              disabled={!alsoNstock}
              placeholder={alsoNstock ? "nStock 文章標題（必填）" : "已停用"}
              className="flex-1 text-sm px-3 py-1.5 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:bg-gray-50 disabled:text-gray-400"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 shrink-0 text-xs text-gray-600 select-none">
              <input
                type="checkbox"
                checked={alsoFb}
                onChange={(e) => setAlsoFb(e.target.checked)}
                className="accent-blue-700"
              />
              同步 Facebook
            </label>
            <input
              type="text"
              value={fbLink}
              onChange={(e) => setFbLink(e.target.value)}
              disabled={!alsoFb}
              placeholder={alsoFb
                ? (alsoNstock ? "FB link card URL（留空=自動帶剛發的 nStock 連結）" : "FB link card URL（選填，會生 link card）")
                : "已停用"}
              className="flex-1 text-sm px-3 py-1.5 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:bg-gray-50 disabled:text-gray-400"
            />
          </div>
          {alsoFb && (
            <div className="flex items-center gap-2 pl-[6.5rem]">
              <input
                type="url"
                value={fbPic}
                onChange={(e) => setFbPic(e.target.value)}
                placeholder="FB 縮圖 URL（選填，覆蓋預設 og:image）"
                className="flex-1 text-sm px-3 py-1.5 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-300"
              />
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className={`text-xs font-medium ${draft.length > 500 ? "text-yellow-600" : "text-gray-400"}`}>
              {draft.length} 字元{draft.length > 500 ? `　• 將切成 ${Math.ceil(draft.length / 490)} 段串留言鏈` : ""}
            </span>
            <button
              onClick={publish}
              disabled={!draft.trim() || publishing}
              className="px-4 py-2 bg-black text-white text-sm rounded-lg font-medium hover:bg-gray-800 disabled:opacity-40 transition flex items-center gap-2"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm0 18c-4.418 0-8-3.582-8-8s3.582-8 8-8 8 3.582 8 8-3.582 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z"/>
              </svg>
              {publishing ? "發布中…" : `發布${[
                alsoThreads && "Threads",
                alsoNstock && "nStock",
                alsoFb && "FB",
              ].filter(Boolean).join(" + ")}`}
            </button>
          </div>

          {publishResult && (
            <div className={`text-sm px-3 py-2 rounded-lg ${publishResult.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"}`}>
              {publishResult.msg}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

    </section>
  );
}

// ── 主頁面 ────────────────────────────────────────────────
// ── 邀請碼管理 ────────────────────────────────────────────────
interface InviteCodeItem {
  id: number;
  code: string;
  created_at: string;
  is_active: boolean;
  used: boolean;
  used_at: string | null;
  used_by_name: string | null;
}

function InviteCodesSection({ token }: { token: string }) {
  const headers = { Authorization: `Bearer ${token}` };
  const [list, setList] = useState<InviteCodeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    axios.get("/api/admin/invite-codes", { headers })
      .then((r) => setList(r.data))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    setCreating(true);
    setMsg(null);
    try {
      await axios.post("/api/admin/invite-codes", {}, { headers });
      load();
    } catch {
      setMsg("建立失敗");
    } finally {
      setCreating(false);
    }
  };

  const handleDeactivate = async (id: number) => {
    await axios.delete(`/api/admin/invite-codes/${id}`, { headers });
    setList((prev) => prev.map((c) => c.id === id ? { ...c, is_active: false } : c));
  };

  const fmtDt = (s: string | null) =>
    s ? new Date(s + "Z").toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }) : "—";

  const active = list.filter((c) => c.is_active && !c.used);
  const used = list.filter((c) => c.used);
  const inactive = list.filter((c) => !c.is_active && !c.used);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">可用 {active.length} 個 · 已使用 {used.length} 個</p>
        <div className="flex items-center gap-2">
          {msg && <span className="text-xs text-red-500">{msg}</span>}
          <button
            onClick={handleCreate}
            disabled={creating}
            className="px-3 py-1.5 text-sm rounded-lg bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50"
          >
            {creating ? "建立中…" : "+ 產生邀請碼"}
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400">載入中…</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-gray-400">尚無邀請碼，點「產生邀請碼」建立第一個。</p>
      ) : (
        <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr>
                <th className="px-4 py-2.5 text-left">邀請碼</th>
                <th className="px-4 py-2.5 text-left">建立時間</th>
                <th className="px-4 py-2.5 text-left">狀態</th>
                <th className="px-4 py-2.5 text-left">使用者</th>
                <th className="px-4 py-2.5 text-left">使用時間</th>
                <th className="px-4 py-2.5 text-left"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {list.map((c) => (
                <tr key={c.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2.5 font-mono text-gray-800">{c.code}</td>
                  <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">{fmtDt(c.created_at)}</td>
                  <td className="px-4 py-2.5">
                    {c.used ? (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">已使用</span>
                    ) : c.is_active ? (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-600 font-medium">可用</span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-red-50 text-red-500">已停用</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-gray-600">{c.used_by_name ?? "—"}</td>
                  <td className="px-4 py-2.5 text-gray-400 whitespace-nowrap">{fmtDt(c.used_at)}</td>
                  <td className="px-4 py-2.5">
                    {c.is_active && !c.used && (
                      <button
                        onClick={() => handleDeactivate(c.id)}
                        className="text-xs text-red-400 hover:text-red-600 transition"
                      >
                        停用
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}


function SyncHistorySection() {
  const [logs, setLogs] = useState<SyncLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [noReportCount, setNoReportCount] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [sinceDate, setSinceDate] = useState("");

  const handleExport = async () => {
    try {
      const res = await fetch("/api/admin/export", {
        headers: { Authorization: `Bearer ${localStorage.getItem("auth_token")}` },
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "investreport_export.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setMsg({ ok: false, text: "匯出失敗" });
    }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setMsg(null);
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const res = await fetch("/api/admin/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("auth_token")}`,
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? "匯入失敗");
      setMsg({ ok: true, text: `匯入完成：DriveFile +${data.drive_files_added}（略過 ${data.drive_files_skipped}）、Report +${data.reports_added}（略過 ${data.reports_skipped}）` });
      load();
    } catch (err: unknown) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "匯入失敗" });
    } finally {
      setImporting(false);
      if (importRef.current) importRef.current.value = "";
    }
  };

  const [showDriveFiles, setShowDriveFiles] = useState(false);
  type DriveFileRow = { drive_file_id: string; filename: string; processed_at: string | null; has_report: boolean; stock_code: string | null; stock_name: string | null; recommendation: string | null; report_date: string | null };
  const [driveFiles, setDriveFiles] = useState<DriveFileRow[]>([]);
  const [driveTotal, setDriveTotal] = useState(0);
  const [driveOffset, setDriveOffset] = useState(0);
  const [driveStatus, setDriveStatus] = useState<"all" | "synced" | "no_result">("all");
  const [driveQ, setDriveQ] = useState("");
  const [driveLoading, setDriveLoading] = useState(false);
  const DRIVE_PAGE = 50;

  const loadDriveFiles = async (offset = 0, status = driveStatus, q = driveQ) => {
    setDriveLoading(true);
    try {
      const d = await syncApi.driveFiles(status, q, DRIVE_PAGE, offset);
      setDriveFiles(d.files);
      setDriveTotal(d.total);
      setDriveOffset(offset);
    } finally {
      setDriveLoading(false);
    }
  };

  const toggleDriveFiles = () => {
    if (!showDriveFiles && driveFiles.length === 0) loadDriveFiles(0);
    setShowDriveFiles((v) => !v);
  };

  const load = () => {
    setLoading(true);
    syncApi.history(30).then(setLogs).finally(() => setLoading(false));
    syncApi.noReportCount()
      .then((d) => setNoReportCount(d.without_report))
      .catch(() => {});
  };

  useEffect(() => { load(); }, []);

  const handleSync = async (since?: string) => {
    setSyncing(true);
    setMsg(null);
    try {
      await syncApi.trigger(since || undefined);
      setMsg({ ok: true, text: since ? `同步已啟動（從 ${since} 起）` : "全量同步已啟動，稍後重新整理查看結果" });
      setTimeout(load, 5000);
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number; data?: { detail?: string } } })?.response?.status;
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setMsg({ ok: false, text: status === 409 ? (detail ?? "已有同步進行中") : "啟動失敗" });
    } finally {
      setSyncing(false);
    }
  };

  const handleReanalyze = async () => {
    setReanalyzing(true);
    setMsg(null);
    try {
      const res = await syncApi.reanalyze(50);
      setMsg({ ok: true, text: res.message });
      setTimeout(load, 3000);
    } catch {
      setMsg({ ok: false, text: "重新分析啟動失敗" });
    } finally {
      setReanalyzing(false);
    }
  };

  const fmtDt = (s: string | null) =>
    s ? new Date(s + (s.includes("+") ? "" : "Z")).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }) : "—";

  const duration = (log: SyncLogEntry) => {
    if (!log.finished_at) return "進行中…";
    const s = Math.round((new Date(log.finished_at).getTime() - new Date(log.started_at).getTime()) / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-gray-500">顯示最近 30 筆同步記錄</p>
        <div className="flex items-center gap-2 flex-wrap">
          {msg && <span className={`text-xs ${msg.ok ? "text-green-600" : "text-red-500"}`}>{msg.text}</span>}
          <button onClick={load} className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 hover:bg-gray-50">重新整理</button>
          <button onClick={handleExport} className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 hover:bg-gray-50">匯出資料</button>
          <label className={`px-3 py-1.5 text-sm rounded-lg border border-gray-300 hover:bg-gray-50 cursor-pointer ${importing ? "opacity-50 pointer-events-none" : ""}`}>
            {importing ? "匯入中…" : "匯入資料"}
            <input ref={importRef} type="file" accept=".json" className="hidden" onChange={handleImportFile} />
          </label>
          <button
            onClick={toggleDriveFiles}
            className="px-3 py-1.5 text-sm rounded-lg border border-blue-400 text-blue-600 hover:bg-blue-50"
          >
            {showDriveFiles ? "收起明細" : "雲端檔案明細"}
          </button>
          {noReportCount !== null && noReportCount > 0 && (
            <button
              onClick={handleReanalyze}
              disabled={reanalyzing}
              className="px-3 py-1.5 text-sm rounded-lg bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50 flex items-center gap-1.5"
            >
              {reanalyzing ? "分析中…" : `重新分析 (${noReportCount} 筆無結果)`}
            </button>
          )}
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={sinceDate}
              onChange={e => setSinceDate(e.target.value)}
              className="text-sm px-2 py-1.5 rounded-lg border border-gray-300 text-gray-600 focus:outline-none focus:border-blue-400"
              title="留空=全量掃描，填日期=只掃該日之後的新檔"
            />
            <button
              onClick={() => handleSync(sinceDate || undefined)}
              disabled={syncing}
              className="px-3 py-1.5 text-sm rounded-lg bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 whitespace-nowrap"
            >
              {syncing ? "啟動中…" : sinceDate ? `從 ${sinceDate} 同步` : "全量同步"}
            </button>
          </div>
        </div>
      </div>

      <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <p className="px-5 py-6 text-gray-400 text-sm">載入中…</p>
        ) : logs.length === 0 ? (
          <p className="px-5 py-6 text-gray-400 text-sm">尚無同步記錄，點「立即同步」開始第一次同步。</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr>
                <th className="px-4 py-2.5 text-left">開始時間</th>
                <th className="px-4 py-2.5 text-left">觸發</th>
                <th className="px-4 py-2.5 text-right">處理</th>
                <th className="px-4 py-2.5 text-right">略過</th>
                <th className="px-4 py-2.5 text-right">無結果</th>
                <th className="px-4 py-2.5 text-right">新增報告</th>
                <th className="px-4 py-2.5 text-right">錯誤</th>
                <th className="px-4 py-2.5 text-right">耗時</th>
                <th className="px-4 py-2.5 text-left">狀態</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {logs.map((log) => (
                <tr key={log.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmtDt(log.started_at)}</td>
                  <td className="px-4 py-2.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${log.trigger === "scheduled" ? "bg-purple-50 text-purple-600" : "bg-blue-50 text-blue-600"}`}>
                      {log.trigger === "scheduled" ? "排程" : "手動"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right text-gray-700 tabular-nums">{log.processed}</td>
                  <td className="px-4 py-2.5 text-right text-gray-400 tabular-nums">{log.skipped}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    <span className={(log.no_report ?? 0) > 0 ? "text-amber-500 font-medium" : "text-gray-400"}>{log.no_report ?? 0}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    <span className={log.new_reports > 0 ? "text-green-600 font-semibold" : "text-gray-400"}>{log.new_reports}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    <span className={log.errors > 0 ? "text-red-500 font-medium" : "text-gray-400"}>{log.errors}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right text-gray-500 whitespace-nowrap">{duration(log)}</td>
                  <td className="px-4 py-2.5 max-w-xs">
                    {log.status === "running" ? (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-50 text-yellow-600 font-medium animate-pulse">同步中</span>
                    ) : log.status === "error" ? (
                      <div>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-red-50 text-red-600 font-medium">失敗</span>
                        {log.error_message && (
                          <p className="text-xs text-red-400 mt-1 break-all">{log.error_message}</p>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-600 font-medium">完成</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {showDriveFiles && (
        <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              {(["all", "synced", "no_result"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => { setDriveStatus(s); loadDriveFiles(0, s, driveQ); }}
                  className={`px-2.5 py-1 text-xs rounded-full border transition ${driveStatus === s ? "bg-blue-500 text-white border-blue-500" : "border-gray-300 text-gray-600 hover:bg-gray-50"}`}
                >
                  {s === "all" ? `全部（${driveTotal}）` : s === "synced" ? "已分析" : "無結果"}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={driveQ}
                onChange={(e) => setDriveQ(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && loadDriveFiles(0, driveStatus, driveQ)}
                placeholder="搜尋檔名…"
                className="px-3 py-1 text-xs border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-300 w-44"
              />
              <button
                onClick={() => loadDriveFiles(0, driveStatus, driveQ)}
                className="px-2.5 py-1 text-xs rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-600"
              >搜尋</button>
            </div>
          </div>
          {driveLoading ? (
            <p className="px-5 py-4 text-sm text-gray-400">載入中…</p>
          ) : driveFiles.length === 0 ? (
            <p className="px-5 py-4 text-sm text-gray-400">沒有符合的檔案</p>
          ) : (
            <>
              <div className="max-h-[480px] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 text-gray-400 sticky top-0 z-10">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium">狀態</th>
                      <th className="px-4 py-2 text-left font-medium">檔名</th>
                      <th className="px-4 py-2 text-left font-medium">股票</th>
                      <th className="px-4 py-2 text-left font-medium hidden sm:table-cell">評等</th>
                      <th className="px-4 py-2 text-left font-medium hidden sm:table-cell">報告日期</th>
                      <th className="px-4 py-2 text-left font-medium hidden sm:table-cell">同步時間</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {driveFiles.map((f) => (
                      <tr key={f.drive_file_id} className="hover:bg-gray-50">
                        <td className="px-4 py-1.5 whitespace-nowrap">
                          {f.has_report ? (
                            <span className="inline-flex items-center gap-1 text-green-600 font-medium">
                              <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />已分析
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-amber-500">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />無結果
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-1.5 text-gray-700 font-mono max-w-[220px] sm:max-w-xs truncate" title={f.filename}>{f.filename}</td>
                        <td className="px-4 py-1.5 whitespace-nowrap">
                          {f.stock_code ? (
                            <span className="font-medium text-blue-600">{f.stock_code}{f.stock_name ? ` ${f.stock_name}` : ""}</span>
                          ) : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-4 py-1.5 hidden sm:table-cell text-gray-600">{f.recommendation ?? <span className="text-gray-300">—</span>}</td>
                        <td className="px-4 py-1.5 hidden sm:table-cell text-gray-400 whitespace-nowrap">{f.report_date ?? "—"}</td>
                        <td className="px-4 py-1.5 hidden sm:table-cell text-gray-400 whitespace-nowrap">
                          {f.processed_at ? new Date(f.processed_at + "Z").toLocaleDateString("zh-TW") : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-2 border-t border-gray-100 flex items-center gap-3 text-xs text-gray-500">
                <span>{driveOffset + 1}–{Math.min(driveOffset + DRIVE_PAGE, driveTotal)} / {driveTotal} 筆</span>
                <button
                  onClick={() => loadDriveFiles(Math.max(0, driveOffset - DRIVE_PAGE))}
                  disabled={driveOffset === 0}
                  className="px-2 py-0.5 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40"
                >上一頁</button>
                <button
                  onClick={() => loadDriveFiles(driveOffset + DRIVE_PAGE)}
                  disabled={driveOffset + DRIVE_PAGE >= driveTotal}
                  className="px-2 py-0.5 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40"
                >下一頁</button>
              </div>
            </>
          )}
        </section>
      )}

      {/* 籌碼歷史補抓 */}
      <ChipsBackfillSection />
    </div>
  );
}

function ChipsBackfillSection() {
  const [chipsCount, setChipsCount] = useState<number | null>(null);
  const [backfilling, setBackfilling] = useState(false);
  const [chipMsg, setChipMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const token = localStorage.getItem("auth_token");
  const headers = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    axios.get("/api/chips/history?days=90", { headers })
      .then((r) => setChipsCount(r.data.length))
      .catch(() => setChipsCount(0));
  }, []);

  const handleBackfill = async (days: number) => {
    setBackfilling(true);
    setChipMsg(null);
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - days);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    try {
      const r = await axios.post(
        `/api/chips/backfill?start=${fmt(start)}&end=${fmt(end)}`, {},
        { headers, timeout: 120000 }
      );
      const { saved, missing } = r.data;
      setChipMsg({ ok: true, text: `補抓完成：新增 ${saved.length} 筆，無資料 ${missing.length} 筆` });
      axios.get("/api/chips/history?days=90", { headers })
        .then((r2) => setChipsCount(r2.data.length))
        .catch(() => {});
    } catch {
      setChipMsg({ ok: false, text: "補抓失敗，請稍後再試" });
    } finally {
      setBackfilling(false);
    }
  };

  return (
    <section className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-700">籌碼歷史資料</h3>
          <p className="text-xs text-gray-400 mt-0.5">
            資料庫目前有 <span className={`font-medium ${(chipsCount ?? 0) < 3 ? "text-red-500" : "text-green-600"}`}>{chipsCount ?? "…"}</span> 筆
            {(chipsCount ?? 0) < 3 && " ⚠️ 不足 3 筆，折線圖不會顯示"}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {chipMsg && <span className={`text-xs ${chipMsg.ok ? "text-green-600" : "text-red-500"}`}>{chipMsg.text}</span>}
          {[14, 30, 60].map((d) => (
            <button
              key={d}
              onClick={() => handleBackfill(d)}
              disabled={backfilling}
              className="px-3 py-1.5 text-xs rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
            >
              {backfilling ? "補抓中…" : `補抓近 ${d} 天`}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

export default function AdminPage() {
  const { user, token } = useAuth();
  const location = useLocation();
  const locState = location.state as { tab?: "publish" | "daily" | "users"; selectedIds?: number[] } | null;
  const [tab, setTab] = useState<"publish" | "daily" | "users" | "sync" | "invites">(locState?.tab ?? "sync");
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [selectedUser, setSelectedUser] = useState<UserRecord | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);

  const headers = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    if (tab !== "users") return;
    setLoading(true);
    axios.get("/api/admin/users", { headers })
      .then((r) => setUsers(r.data))
      .finally(() => setLoading(false));
  }, [tab]);

  const loadSessions = (u: UserRecord) => {
    setSelectedUser(u);
    axios.get(`/api/admin/users/${u.id}/sessions`, { headers })
      .then((r) => setSessions(r.data));
  };

  const toggleAdmin = async (u: UserRecord) => {
    await axios.patch(`/api/admin/users/${u.id}/admin?is_admin=${!u.is_admin}`, {}, { headers });
    setUsers((prev) => prev.map((x) => x.id === u.id ? { ...x, is_admin: !u.is_admin } : x));
  };

  if (!user) return <Navigate to="/" replace />;
  if (!user.is_admin) return (
    <div className="max-w-2xl mx-auto py-16 px-4 text-center text-gray-500">無管理員權限</div>
  );

  const tabs = [
    { id: "sync",    label: "同步記錄" },
    { id: "daily",   label: "每日草稿" },
    { id: "publish", label: "社群發布" },
    { id: "users",   label: "帳號管理" },
    { id: "invites", label: "邀請碼" },
  ] as const;

  return (
    <div className="max-w-5xl mx-auto py-8 px-4 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-800">後台管理</h1>
      </div>

      {/* Tab 列 */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-5 py-2 rounded-lg text-sm font-medium transition ${
              tab === t.id ? "bg-white text-gray-800 shadow-sm" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "publish" && <PublishSection token={token ?? ""} initialIds={locState?.selectedIds} />}

      {tab === "daily" && <DailySection token={token ?? ""} />}

      {tab === "sync" && <SyncHistorySection />}

      {tab === "invites" && <InviteCodesSection token={token ?? ""} />}

      {tab === "users" && (
        <>{/* 使用者列表 */}
      <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-semibold text-gray-700">使用者列表</h2>
          <span className="text-sm text-gray-400">{users.length} 位</span>
        </div>

        {loading ? (
          <p className="px-5 py-4 text-gray-400">載入中…</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr>
                <th className="px-4 py-2 text-left">使用者</th>
                <th className="px-4 py-2 text-left">Email</th>
                <th className="px-4 py-2 text-center">登入次數</th>
                <th className="px-4 py-2 text-left">最後登入</th>
                <th className="px-4 py-2 text-left">加入時間</th>
                <th className="px-4 py-2 text-center">Admin</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-gray-50 transition">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {u.picture && <img src={u.picture} className="w-7 h-7 rounded-full" alt="" />}
                      <span className="font-medium text-gray-800">{u.name || "—"}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{u.email}</td>
                  <td className="px-4 py-3 text-center">
                    <span className="font-semibold text-gray-700">{u.login_count}</span>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{u.last_login?.slice(0, 16).replace("T", " ")}</td>
                  <td className="px-4 py-3 text-gray-500">{u.created_at?.slice(0, 10)}</td>
                  <td className="px-4 py-3 text-center">
                    <button onClick={() => toggleAdmin(u)}
                      className={`text-xs px-2 py-0.5 rounded font-medium transition ${
                        u.is_admin ? "bg-purple-100 text-purple-700 hover:bg-purple-200" : "bg-gray-100 text-gray-400 hover:bg-gray-200"
                      }`}>
                      {u.is_admin ? "✓ Admin" : "一般"}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <button onClick={() => loadSessions(u)}
                      className="text-xs text-blue-500 hover:underline">
                      登入紀錄
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selectedUser && (
          <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
              <h2 className="font-semibold text-gray-700">{selectedUser.name} 的登入紀錄</h2>
              <button onClick={() => setSelectedUser(null)} className="text-xs text-gray-400 hover:text-gray-600">關閉</button>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
                <tr>
                  <th className="px-4 py-2 text-left">時間</th>
                  <th className="px-4 py-2 text-left">IP</th>
                  <th className="px-4 py-2 text-left">瀏覽器</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sessions.map((s) => (
                  <tr key={s.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2 text-gray-700">{s.logged_in_at?.slice(0, 16).replace("T", " ")}</td>
                    <td className="px-4 py-2 text-gray-500">{s.ip_address || "—"}</td>
                    <td className="px-4 py-2 text-gray-400 text-xs max-w-xs truncate">{s.user_agent || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        </>
      )}
    </div>
  );
}
