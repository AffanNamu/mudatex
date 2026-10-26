export function Stars({ value, label }: { value: number; label?: string }) {
  const full = Math.round(value);
  return (
    <span role="img" aria-label={label ?? `${value} out of 5 stars`} style={{ color: 'var(--accent)', letterSpacing: 2 }}>
      {'★'.repeat(full)}<span style={{ color: 'var(--line)' }}>{'★'.repeat(5 - full)}</span>
    </span>
  );
}
