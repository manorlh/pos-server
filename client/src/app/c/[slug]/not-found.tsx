/** A card that does not exist (or no longer does): neutral, in both languages, no details. */
export default function CardNotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-2 bg-slate-50 p-6 text-center text-slate-800">
      <p lang="he" dir="rtl" className="text-lg font-medium">
        הכרטיס לא נמצא.
      </p>
      <p lang="en" dir="ltr" className="text-slate-700">
        Card not found.
      </p>
    </main>
  );
}
