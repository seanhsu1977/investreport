import type { Report } from "../api/client";
import RecommendationBadge from "./RecommendationBadge";

interface Props {
  report: Report;
}

export default function ReportCard({ report }: Props) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <RecommendationBadge value={report.recommendation} />
          {report.target_price && (
            <span className="text-sm text-gray-500">
              目標價 <span className="font-semibold text-gray-800">{report.target_price}</span>
            </span>
          )}
        </div>
        <div className="text-xs text-gray-400">
          {report.report_date ?? report.created_at?.slice(0, 10)}
          {report.analyst && <span className="ml-2">· {report.analyst}</span>}
        </div>
      </div>

      {report.summary && (
        <p className="text-sm text-gray-700 leading-relaxed mb-3">{report.summary}</p>
      )}

      {report.key_points.length > 0 && (
        <ul className="space-y-1">
          {report.key_points.map((pt, i) => (
            <li key={i} className="text-sm text-gray-600 flex gap-2">
              <span className="text-blue-400 mt-0.5">▸</span>
              <span>{pt}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
