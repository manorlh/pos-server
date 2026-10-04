/**
 * "Powered by R2M": the maker's line, small and quiet at the foot of the dashboard's
 * sidebar and its sign-in pages — the same line the tills show. Not translated: it is a
 * name, and reads the same in every language.
 */
export function PoweredBy({ className = '' }: { className?: string }) {
  return (
    <p dir="ltr" className={`text-center text-xs text-muted-foreground ${className}`}>
      Powered by <span className="font-semibold">R2M</span>
    </p>
  );
}
