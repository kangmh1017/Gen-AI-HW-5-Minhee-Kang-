/**
 * Displays compute_stats_json result: field, count, mean, median, std, min, max.
 * StatsError shows friendly error when field is not numeric or no values.
 */
import './StatsResult.css';

export function StatsError({ message }) {
  if (!message) return null;
  return <div className="stats-result-error">{message}</div>;
}

const formatNum = (n) => {
  if (n == null || typeof n !== 'number') return '—';
  if (Number.isInteger(n) || (Number.isFinite(n) && n === Math.floor(n))) return Math.round(n).toLocaleString();
  return Number(n.toFixed(4)).toLocaleString();
};

export default function StatsResult({ result }) {
  if (!result || result.error) return null;
  const { field, count, mean, median, std, min, max } = result;
  if (typeof mean !== 'number') return null;

  const rows = [
    { label: 'Field', value: field || '—' },
    { label: 'Count', value: formatNum(count) },
    { label: 'Mean', value: formatNum(mean) },
    { label: 'Median', value: formatNum(median) },
    { label: 'Std', value: formatNum(std) },
    { label: 'Min', value: formatNum(min) },
    { label: 'Max', value: formatNum(max) },
  ];

  return (
    <div className="stats-result">
      <div className="stats-result-title">Statistics: {field || 'field'}</div>
      <table className="stats-result-table">
        <tbody>
          {rows.map(({ label, value }) => (
            <tr key={label}>
              <td className="stats-result-label">{label}</td>
              <td className="stats-result-value">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
