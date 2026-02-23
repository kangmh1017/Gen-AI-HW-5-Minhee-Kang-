import { useState, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import './MetricVsTimeChart.css';

export default function MetricVsTimeChart({ data, metricField, onDownload }) {
  const [enlarged, setEnlarged] = useState(false);
  const chartRef = useRef(null);

  const chartData = (data || []).map((d, i) => ({
    ...d,
    index: i + 1,
    name: d.label || d.date?.slice(0, 10) || `#${i + 1}`,
  }));

  const handleDownloadCsv = (e) => {
    e.stopPropagation();
    if (onDownload) onDownload();
    else {
      const csv = ['date,value,label'].concat(
        (data || []).map((d) => `${d.date || ''},${d.value ?? ''},"${(d.label || '').replace(/"/g, '""')}"`)
      ).join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `metric_vs_time_${metricField || 'data'}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const handleDownloadSvg = (e) => {
    e.stopPropagation();
    const wrapper = chartRef.current;
    const svg = wrapper?.querySelector('svg');
    if (!svg) return;
    const serializer = new XMLSerializer();
    const str = serializer.serializeToString(svg);
    const blob = new Blob([str], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `metric_vs_time_${metricField || 'metric'}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const content = (
    <div className="metric-vs-time-chart" ref={chartRef}>
      <div className="metric-vs-time-header">
        <div className="metric-vs-time-header-left">
          <span className="metric-vs-time-title">{metricField || 'Metric'} vs Time</span>
          <span className="metric-vs-time-caption">Time = video release date (published_at)</span>
        </div>
        <div className="metric-vs-time-actions">
          <button type="button" className="metric-vs-time-download-btn" onClick={handleDownloadCsv}>
            Download CSV
          </button>
          <button type="button" className="metric-vs-time-download-btn" onClick={handleDownloadSvg}>
            Download SVG
          </button>
          {!enlarged && (
            <button type="button" className="metric-vs-time-enlarge-btn" onClick={() => setEnlarged(true)}>
              Enlarge
            </button>
          )}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={enlarged ? 400 : 240}>
        <LineChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
          <XAxis dataKey="name" stroke="rgba(255,255,255,0.6)" fontSize={11} tick={{ fill: 'rgba(255,255,255,0.7)' }} />
          <YAxis stroke="rgba(255,255,255,0.6)" fontSize={11} tick={{ fill: 'rgba(255,255,255,0.7)' }} />
          <Tooltip
            contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 8 }}
            labelStyle={{ color: '#fff' }}
          />
          <Line type="monotone" dataKey="value" stroke="#ffd700" strokeWidth={2} dot={{ fill: '#ffd700', r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
      {enlarged && (
        <button type="button" className="metric-vs-time-close-btn" onClick={() => setEnlarged(false)}>
          Close
        </button>
      )}
    </div>
  );

  if (enlarged) {
    return (
      <div className="metric-vs-time-lightbox" onClick={() => setEnlarged(false)} role="button" tabIndex={0}>
        <div className="metric-vs-time-lightbox-inner" onClick={(e) => e.stopPropagation()}>
          {content}
        </div>
      </div>
    );
  }

  return (
    <div className="metric-vs-time-wrap" onClick={() => setEnlarged(true)} role="button" tabIndex={0}>
      {content}
    </div>
  );
}
