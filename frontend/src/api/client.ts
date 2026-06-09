import axios from "axios";

const api = axios.create({ baseURL: "/api" });

// 每個請求自動帶上 localStorage 的 JWT token
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("auth_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export interface StockSummary {
  stock_code: string;
  stock_name: string | null;
  report_count: number;
  latest_at: string;
  latest_recommendation: string | null;
  latest_target_price: number | null;
}

export interface Report {
  id: number;
  stock_code: string;
  stock_name: string | null;
  recommendation: string | null;
  target_price: number | null;
  analyst: string | null;
  report_date: string | null;
  summary: string | null;
  key_points: string[];
  created_at: string;
  source_filename: string | null;
  mentioned_stocks?: string[];
}

export interface WatchlistItem {
  stock_code: string;
  stock_name: string | null;
  group_id: number | null;
  added_at: string;
  latest_report: Report | null;
}

export interface WatchlistGroup {
  id: number;
  name: string;
  sort_order: number;
}

export interface StockReportsResponse {
  reports: Report[];
  related_news: Report[];
}

export interface RecentResponse {
  stock_reports: Report[];
  market_news: Report[];
}

export interface StockPrice {
  price: number | null;
  change: number | null;
  change_pct: number | null;
  date: string | null;
}

export interface RecommendationItem {
  code: string;
  name: string | null;
  current_price: number | null;
  change_pct: number | null;
  volume: number | null;
  target_price: number;
  upside_pct: number | null;
  latest_recommendation: string | null;
  latest_analyst: string | null;
  latest_report_date: string | null;
  report_count: number;
  rec_avg: number;
  rec_max_score: number;
  inst_5d_net: number;
  ma_signal: string | null;
  volume_signal: string | null;
  rsi: number | null;
  score: number;
  score_breakdown: {
    upside: number;
    consensus: number;
    institutional: number;
    technical: number;
  };
}

export interface UpsideRankingItem {
  stock_code: string;
  stock_name: string | null;
  target_price: number;
  current_price: number;
  volume: number | null;
  upside_pct: number;
  recommendation: string | null;
  analyst: string | null;
  report_date: string | null;
  report_count: number;
}

export interface MarketIndex {
  name: string;
  current: number;
  change: number;
  change_pct: number;
  ma5: number;
  ma20: number;
  ma_signal: string;
  volume_signal: string;
  rsi: number | null;
  rsi_signal: string;
  bb_upper: number | null;
  bb_lower: number | null;
  bb_pct_b: number | null;
  bb_signal: string | null;
  suggestion: string;
  resistance: number[];
  support: number[];
  tower: TowerSignal | null;
  updated_at: string;
}

export interface StockPriceData {
  price: number | null;
  change: number | null;
  change_pct: number | null;
}

export interface TowerSignal {
  color: "陽" | "陰";
  count: number;
  signal: "轉陽" | "轉陰" | "持續陽" | "持續陰";
}

export interface StockSignal {
  current_price: number;
  price_change_5d: number | null;
  ma5: number;
  ma10: number | null;
  ma20: number;
  ma60: number | null;
  ma_signal: "多頭排列" | "空頭排列" | "均線糾結";
  ma_position: string | null;
  volume_signal: "量增" | "量縮" | "量持平";
  rsi: number | null;
  rsi_signal: "超買" | "超賣" | "正常" | "無";
  bb_upper: number | null;
  bb_lower: number | null;
  bb_pct_b: number | null;
  bb_signal: string | null;
  suggestion: string;
  resistance: number[];
  support: number[];
  tower: TowerSignal | null;
  updated_at: string;
}

interface OhlcPoint  { time: number; open: number; high: number; low: number; close: number }
interface LinePoint  { time: number; value?: number }

export interface KlineResponse {
  candles: OhlcPoint[];
  ma5: LinePoint[]; ma10: LinePoint[]; ma20: LinePoint[]; ma60: LinePoint[];
  kdj_k: LinePoint[]; kdj_d: LinePoint[]; kdj_j: LinePoint[];
  kdj_k10_price: number | null;
  kdj_k20_price: number | null;
  kdj_k80_price: number | null;
  kdj_k90_price: number | null;
  kdj_range_low:  number | null;
  kdj_range_high: number | null;
  kdj_cur_k: number | null;
  kdj_cur_d: number | null;
  kdj_cur_j: number | null;
}

export const stocksApi = {
  list: () => api.get<StockSummary[]>("/stocks").then((r) => r.data),
  reports: (code: string) =>
    api.get<StockReportsResponse>(`/stocks/${code}/reports`).then((r) => r.data),
  recent: (days: number) =>
    api.get<RecentResponse>(`/stocks/recent?days=${days}`).then((r) => r.data),
  price: (code: string) =>
    api.get<StockPrice>(`/stocks/${code}/price`).then((r) => r.data),
  upside_ranking: (days: number) =>
    api.get<UpsideRankingItem[]>(`/stocks/upside-ranking?days=${days}`).then((r) => r.data),
  recommendations: (params: { days: number; min_reports: number; rec_filter: string; limit?: number }) =>
    api.get<{ items: RecommendationItem[]; warnings: string[]; computed_at: string }>(
      "/stocks/recommendations", { params }
    ).then((r) => r.data),
  batch_signals: (codes: string[]) =>
    api.get<Record<string, StockSignal>>(`/stocks/batch-signals?codes=${codes.join(",")}`).then((r) => r.data),
  batch_prices: (codes: string[]) =>
    api.get<Record<string, StockPriceData>>(`/stocks/batch-prices?codes=${codes.join(",")}`).then((r) => r.data),
  market_overview: () =>
    api.get<Record<string, MarketIndex>>("/stocks/market-overview").then((r) => r.data),
  market_kline: (index: "taiex" | "twoii" = "taiex") =>
    api.get<KlineResponse>(`/stocks/market-kline?index=${index}`).then((r) => r.data),
  txf_kline: () =>
    api.get<KlineResponse>("/stocks/txf-kline").then((r) => r.data),
  kline: (code: string) =>
    api.get<KlineResponse>(`/stocks/${code}/kline`).then((r) => r.data),
};

export const searchApi = {
  search: (q: string) =>
    api.get<RecentResponse>(`/stocks/search?q=${encodeURIComponent(q)}`).then((r) => r.data),
};

export const watchlistApi = {
  get: () => api.get<WatchlistItem[]>("/watchlist").then((r) => r.data),
  add: (stock_code: string, stock_name?: string) =>
    api.post("/watchlist", { stock_code, stock_name }).then((r) => r.data),
  remove: (stock_code: string) => api.delete(`/watchlist/${stock_code}`),
  assignGroup: (stock_code: string, group_id: number | null) =>
    api.patch(`/watchlist/${stock_code}/group`, { group_id }).then((r) => r.data),
  parseImage: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return api.post<{ stocks: { code: string; name: string | null }[] }>(
      "/watchlist/parse-image", form
    ).then((r) => r.data);
  },
};

export const watchlistGroupsApi = {
  list: () => api.get<WatchlistGroup[]>("/watchlist/groups").then((r) => r.data),
  create: (name: string) => api.post<WatchlistGroup>("/watchlist/groups", { name }).then((r) => r.data),
  rename: (id: number, name: string) => api.patch<WatchlistGroup>(`/watchlist/groups/${id}`, { name }).then((r) => r.data),
  delete: (id: number) => api.delete(`/watchlist/groups/${id}`),
};

export interface RevenueData {
  year: number;
  month: number;
  revenue: number;
  mom_pct: number | null;
  yoy_pct: number | null;
  ytd: number;
  ytd_yoy_pct: number | null;
}

export interface InstDay {
  date: string;
  foreign: number;
  trust: number;
  dealer: number;
  total: number;
}

export interface FundamentalsResponse {
  revenue: RevenueData | null;
  institutional: InstDay[] | null;
}

export interface FundamentalSummary {
  revenue: RevenueData | null;
  inst_latest: InstDay | null;
}

export const fundamentalsApi = {
  get: (code: string) =>
    api.get<FundamentalsResponse>(`/stocks/${code}/fundamentals`).then((r) => r.data),
  batch: (codes: string[]) =>
    api.get<Record<string, FundamentalSummary>>(`/stocks/batch-fundamentals?codes=${codes.join(",")}`).then((r) => r.data),
};


export interface SyncLogEntry {
  id: number;
  started_at: string;
  finished_at: string | null;
  trigger: "manual" | "scheduled";
  processed: number;
  skipped: number;
  errors: number;
  no_report: number;
  new_reports: number;
  status: "running" | "done" | "error";
  error_message: string | null;
}

export const syncApi = {
  status: () => api.get("/sync/status").then((r) => r.data),
  progress: () => api.get("/sync/progress").then((r) => r.data),
  trigger: (since?: string) =>
    api.post("/sync", null, { params: since ? { since } : {} }).then((r) => r.data),
  cancel: () => api.post("/sync/cancel").then((r) => r.data),
  history: (limit = 20) =>
    api.get<SyncLogEntry[]>(`/sync/history?limit=${limit}`).then((r) => r.data),
  noReportCount: () =>
    api.get<{ total_drive_files: number; without_report: number }>("/sync/no-report-count").then((r) => r.data),
  noReportFiles: (limit = 100, offset = 0) =>
    api.get<{ total: number; offset: number; limit: number; files: { drive_file_id: string; filename: string; modified_at: string | null }[] }>(
      `/sync/no-report-files?limit=${limit}&offset=${offset}`
    ).then((r) => r.data),
  reanalyze: (limit = 50) =>
    api.post<{ queued: number; message: string }>(`/sync/reanalyze?limit=${limit}`).then((r) => r.data),
  driveFiles: (status: "all" | "synced" | "no_result" = "all", q = "", limit = 50, offset = 0) =>
    api.get<{
      total: number; offset: number; limit: number;
      files: {
        drive_file_id: string; filename: string; processed_at: string | null;
        has_report: boolean; stock_code: string | null; stock_name: string | null;
        recommendation: string | null; report_date: string | null;
      }[]
    }>(`/sync/drive-files`, { params: { status, q, limit, offset } }).then((r) => r.data),
};

export interface InstitutionPosition {
  long_oi: number;
  short_oi: number;
  net_oi: number;
  net_change: number;
}

export interface SpotInstitutional {
  foreign: number;
  trust: number;
  dealer: number;
  total: number;
}

export interface ChipSnapshot {
  date: string;
  taiex: { date: string; close: number; change: number; change_pct: number } | null;
  spot: SpotInstitutional | null;
  txf: {
    foreign: InstitutionPosition | null;
    trust: InstitutionPosition | null;
    dealer: InstitutionPosition | null;
  };
  tmf: {
    total_oi: number;
    close: number | null;
    change: number | null;
    change_pct: number | null;
    foreign: InstitutionPosition | null;
    trust: InstitutionPosition | null;
    dealer: InstitutionPosition | null;
    retail_long: number;
    retail_short: number;
    retail_net: number;
    retail_ratio: number;
    retail_ratio_change?: number;
  };
  fetched_at?: string;
}

export const chipsApi = {
  latest: () => api.get<ChipSnapshot>("/chips/latest").then((r) => r.data),
  history: (days: number) =>
    api.get<ChipSnapshot[]>(`/chips/history?days=${days}`).then((r) => r.data),
  refresh: (target?: string) =>
    api.post("/chips/refresh", null, { params: target ? { target } : {} }).then((r) => r.data),
  backfill: (start: string, end?: string) =>
    api.post("/chips/backfill", null, { params: { start, end } }).then((r) => r.data),
};
