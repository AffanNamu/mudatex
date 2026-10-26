import { formatMoney } from '../lib/money';

export interface DayPoint { date: string; pos: number; online: number }

/** Stacked daily bars: till sales and online orders. The same numbers are in the table below it for anyone who cannot see the chart. */
export function SalesChart({ series, currency, minorUnit }: { series: DayPoint[]; currency: string; minorUnit: number }) {
  if (!series.length) return <p className="muted">No sales in this period.</p>;
  const W = 640; const H = 180; const pad = { l: 8, r: 8, t: 8, b: 22 };
  const max = Math.max(1, ...series.map((d) => d.pos + d.online));
  const bw = (W - pad.l - pad.r) / series.length;
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const fmt = (m: number) => formatMoney(m, currency, minorUnit);
  const label = (d: string) => d.slice(5).replace('-', '/');
  const every = Math.ceil(series.length / 8);
  return (
    <figure className="sales-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Daily sales for ${series.length} days. Highest day ${fmt(max)}.`} width="100%">
        {series.map((d, i) => {
          const x = pad.l + i * bw + bw * 0.12;
          const w = bw * 0.76;
          const posH = (H - pad.t - pad.b) * (d.pos / max);
          const onH = (H - pad.t - pad.b) * (d.online / max);
          return (
            <g key={d.date}>
              <title>{`${d.date}: till ${fmt(d.pos)}, online ${fmt(d.online)}`}</title>
              <rect x={x} y={H - pad.b - posH} width={w} height={posH} fill="var(--chart-1, #2b5fb3)" />
              <rect x={x} y={H - pad.b - posH - onH} width={w} height={onH} fill="var(--chart-2, #c47f17)" />
              {i % every === 0 && <text x={x + w / 2} y={H - 6} fontSize="10" textAnchor="middle" fill="currentColor">{label(d.date)}</text>}
            </g>
          );
        })}
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="currentColor" strokeOpacity="0.3" />
      </svg>
      <figcaption className="legend">
        <span><i style={{ background: 'var(--chart-1, #2b5fb3)' }} /> Till</span>
        <span><i style={{ background: 'var(--chart-2, #c47f17)' }} /> Online</span>
      </figcaption>
      <details>
        <summary>Show the numbers</summary>
        <div className="table-wrap"><table>
          <caption className="sr-only">Sales by day</caption>
          <thead><tr><th scope="col">Day</th><th scope="col" className="num">Till</th><th scope="col" className="num">Online</th></tr></thead>
          <tbody>{series.map((d) => <tr key={d.date}><th scope="row">{d.date}</th><td className="num">{fmt(d.pos)}</td><td className="num">{fmt(d.online)}</td></tr>)}</tbody>
        </table></div>
      </details>
    </figure>
  );
}
