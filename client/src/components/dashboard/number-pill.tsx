/**
 * "#3" before a company's or shop's name: the number the server gave it in its owner's
 * run. Nothing for a row with none (a server that predates it, a tenantless company).
 */
export function NumberPill({
  n,
  className = '',
}: {
  n: number | null | undefined;
  className?: string;
}) {
  if (n == null || n <= 0) return null;
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums leading-none text-primary ${className}`}
    >
      #{n}
    </span>
  );
}
