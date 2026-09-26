import { LineChart, Line, XAxis, YAxis, ReferenceLine, ResponsiveContainer, Tooltip } from 'recharts';

export const STATE_COLORS = {
  baseline: '#8a8f98',
  calm: '#2e9d6a',
  elevated: '#d99a1e',
  overloaded: '#d6453d',
};

// Live heart-rate line for the last ~90 seconds.
export default function VitalsChart({ vitals, baseline }) {
  const now = vitals.at(-1)?.ts ?? Date.now();
  const data = vitals.filter((v) => v.ts >= now - 90000).map((v) => ({ t: Math.round((v.ts - now) / 1000), hr: v.hr }));
  const hrs = data.map((d) => d.hr);
  const lo = Math.floor(Math.min(...hrs, baseline ?? 70) - 8);
  const hi = Math.ceil(Math.max(...hrs, (baseline ?? 70) * 1.35) + 5);

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 10, right: 16, bottom: 0, left: -10 }}>
        <XAxis dataKey="t" type="number" domain={[-90, 0]} tickFormatter={(t) => `${t}s`} stroke="#8a8f98" />
        <YAxis domain={[lo, hi]} stroke="#8a8f98" unit="" />
        <Tooltip formatter={(v) => [`${v} bpm`, 'Heart rate']} labelFormatter={(t) => `${t}s`} />
        {baseline && (
          <>
            <ReferenceLine y={baseline} stroke={STATE_COLORS.calm} strokeDasharray="4 4" label={{ value: 'baseline', fill: '#8a8f98', fontSize: 11 }} />
            <ReferenceLine y={baseline * 1.15} stroke={STATE_COLORS.elevated} strokeDasharray="2 6" />
            <ReferenceLine y={baseline * 1.3} stroke={STATE_COLORS.overloaded} strokeDasharray="2 6" />
          </>
        )}
        <Line type="monotone" dataKey="hr" stroke="#5b8def" strokeWidth={2.5} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
