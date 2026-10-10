'use client';

/**
 * "ניגודיות וסרגל נגישות": try a theme's colours against WCAG AA with the same `ContrastValidator`
 * the menu / ordering / card editors use (the server's gate checks the same rules), and the note
 * that the optional accessibility toolbar never replaces conformance.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ThemeTokens } from '@/lib/contrast';
import { ContrastValidator } from '@/components/public-legal/ContrastValidator';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const NS = 'digitalLegal.theme';

type ColorKey = 'backgroundColor' | 'surfaceColor' | 'textColor' | 'mutedTextColor' | 'primaryColor' | 'buttonColor' | 'buttonTextColor' | 'accentColor';

const START: Record<ColorKey, string> = {
  backgroundColor: '#FFFFFF',
  surfaceColor: '#F8FAFC',
  textColor: '#111827',
  mutedTextColor: '#4B5563',
  primaryColor: '#1F6FEB',
  buttonColor: '#1D4ED8',
  buttonTextColor: '#FFFFFF',
  accentColor: '#15803D',
};

const HEX6 = /^#[0-9a-fA-F]{6}$/;

export function ThemePanel() {
  const t = useTranslations(NS);
  const [theme, setTheme] = useState<Record<ColorKey, string>>(START);
  const keys = Object.keys(START) as ColorKey[];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('title')}</CardTitle>
          <CardDescription>{t('intro')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {keys.map((key) => (
              <div key={key} className="space-y-1">
                <Label htmlFor={`theme-${key}`}>{t(`colors.${key}`)}</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label={t(`colors.${key}`)}
                    value={HEX6.test(theme[key]) ? theme[key] : '#000000'}
                    onChange={(e) => setTheme((prev) => ({ ...prev, [key]: e.target.value.toUpperCase() }))}
                    className="h-9 w-12 cursor-pointer rounded border"
                  />
                  <Input
                    id={`theme-${key}`}
                    dir="ltr"
                    value={theme[key]}
                    onChange={(e) => setTheme((prev) => ({ ...prev, [key]: e.target.value }))}
                  />
                </div>
              </div>
            ))}
          </div>
          <ContrastValidator theme={theme as ThemeTokens} />
        </CardContent>
      </Card>
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('toolbarTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p role="note" className="text-sm">
              {t('toolbarNote')}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('checklistTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">{t('checklist')}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
