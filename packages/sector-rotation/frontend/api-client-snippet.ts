// 節錄自 investreport 專案的 frontend/src/api/client.ts
// SectorRotationPage.tsx 只用到這一個 GET 請求；問答功能是直接用原生 fetch()
// 打 POST /api/stocks/sector-rotation/ask（SSE 串流），見元件內的 sendQA()。
//
// `api` 是專案共用的 axios instance：
//   const api = axios.create({ baseURL: "/api" });

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
