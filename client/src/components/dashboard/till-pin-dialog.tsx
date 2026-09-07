'use client';

/**
 * Setting a till PIN — the credential that lets someone authorise an action at a
 * terminal without ever signing into this dashboard.
 *
 * The rules it enforces here are deliberately only the obvious two (digits, length).
 * Everything else — repeated digits, consecutive runs, the seeded `1234` — is the
 * server's to judge, and its message is shown verbatim. Re-implementing the policy
 * in the browser would give two answers that drift apart, and the browser's would be
 * the one that is wrong.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const MIN_PIN = 4;
const MAX_PIN = 12;

export function TillPinDialog({
  open,
  title,
  description,
  saving,
  onSubmit,
  onOpenChange,
}: {
  open: boolean;
  title: string;
  description: string;
  saving: boolean;
  onSubmit: (pin: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('tillPin');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setPin('');
    setConfirm('');
    setError(null);
  };

  const submit = () => {
    if (pin.length < MIN_PIN || pin.length > MAX_PIN) {
      setError(t('lengthError', { min: MIN_PIN, max: MAX_PIN }));
      return;
    }
    if (pin !== confirm) {
      setError(t('mismatch'));
      return;
    }
    setError(null);
    onSubmit(pin);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="till-pin">{t('pin')}</Label>
            <Input
              id="till-pin"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              value={pin}
              onChange={(e) => {
                setPin(e.target.value.replace(/\D/g, '').slice(0, MAX_PIN));
                setError(null);
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="till-pin-confirm">{t('confirm')}</Label>
            <Input
              id="till-pin-confirm"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value.replace(/\D/g, '').slice(0, MAX_PIN));
                setError(null);
              }}
            />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('cancel')}
          </Button>
          <Button onClick={submit} disabled={saving || !pin || !confirm}>
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
