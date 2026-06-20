'use client';

import { Suspense } from 'react';
import { MobilePairContent } from './MobilePairContent';

export default function MobilePairPage() {
  return (
    <Suspense fallback={<main className="min-h-dvh flex items-center justify-center">טוען...</main>}>
      <MobilePairContent />
    </Suspense>
  );
}
