import axios from "axios";

// 主專案是靠 vite proxy 把 /api 轉給後端；這個 standalone 版沿用同一套規則，
// 見 vite.config.ts 的 server.proxy 設定。
const api = axios.create({ baseURL: "/api" });

export const stocksApi = {
  sectorRotation: () =>
    api.get<{
      bubbles: {
        name: string; x: number; y: number; size: number;
        amt_5d: number; amt_20d: number; rt_amt: number;
        stocks?: {
          code: string; name: string; x: number; y: number; size: number;
          amt_5d: number; amt_20d: number; rt_amt: number;
        }[];
      }[];
      trading_days: number;
      latest_date: string;
      computing?: boolean;
      computed_at: string;
    }>("/stocks/sector-rotation").then((r) => r.data),
};
