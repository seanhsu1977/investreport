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
  added_at: string;
  latest_report: Report | null;
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

export interface UpsideRankingItem {
  stock_code: string;
  stock_name: string | null;
  target_price: number;
  current_price: number;
  upside_pct: number;
  recommendation: string | null;
  analyst: string | null;
  report_date: string | null;
  report_count: number;
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
};

export interface DigestSection {
  title: string;
  tags: string[];
  event: string;
  viewpoint?: string;
  stock_codes?: string[];
  sentiment?: "利多" | "利空" | "中立";
}

export interface DigestResponse {
  date: string;
  sections: DigestSection[];
  report_count: number;
  nstock_count?: number;
  generated_at?: string;
}

export const digestApi = {
  get: (days: number, refresh = false) =>
    api.get<DigestResponse>(`/digest?days=${days}&refresh=${refresh}`).then((r) => r.data),
};

export const syncApi = {
  status: () => api.get("/sync/status").then((r) => r.data),
  progress: () => api.get("/sync/progress").then((r) => r.data),
  trigger: () => api.post("/sync").then((r) => r.data),
  cancel: () => api.post("/sync/cancel").then((r) => r.data),
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
