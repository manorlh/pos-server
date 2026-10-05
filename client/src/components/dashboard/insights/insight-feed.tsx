'use client';

/**
 * The insights feed ("מה חשוב עכשיו"): the server's cards (`type`, `severity`, `params`)
 * in plain Hebrew from the messages, most urgent first, each with what to do about it
 * and a link to the section with the detail. Severity is an icon and a word, never only
 * a colour.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertOctagon, AlertTriangle, ArrowLeft, Info, Lightbulb, TrendingUp } from 'lucide-react';
import { agorot, type InsightCard, type InsightsFeed, type Severity } from '@/lib/insightsApi';
import { formatQuantity } from '@/lib/format';
import { Card, Chip, IOS, Muted, Segmented, hh } from './ios';
import { useDuration } from './open-tables-widget';

export const SEVERITY_STYLE: Record<Severity, { color: string; icon: React.ReactNode }> = {
  critical: { color: IOS.red, icon: <AlertOctagon className="h-4 w-4" /> },
  warning: { color: IOS.orange, icon: <AlertTriangle className="h-4 w-4" /> },
  opportunity: { color: IOS.indigo, icon: <Lightbulb className="h-4 w-4" /> },
  positive: { color: IOS.green, icon: <TrendingUp className="h-4 w-4" /> },
  info: { color: IOS.gray, icon: <Info className="h-4 w-4" /> },
};

type Filter = 'all' | 'attention' | 'opportunity' | 'good';

const FILTERS: Record<Filter, Severity[]> = {
  all: ['critical', 'warning', 'opportunity', 'positive', 'info'],
  attention: ['critical', 'warning'],
  opportunity: ['opportunity'],
  good: ['positive', 'info'],
};

interface CardText {
  title: string;
  body: string;
  action?: string;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const pct = (v: unknown, digits = 0) => `${num(v).toFixed(digits)}%`;
const absPct = (v: unknown, digits = 0) => `${Math.abs(num(v)).toFixed(digits)}%`;
const signed = (v: unknown, digits = 1) => `${num(v) > 0 ? '+' : ''}${num(v).toFixed(digits)}%`;

/** The words of one card. Static message keys only, so every one of them is checked. */
export function useCardText() {
  const t = useTranslations('insights.cards');
  const tr = useTranslations('insights');
  const duration = useDuration();
  const weekdays = tr.raw('weekdayNames') as string[];
  const wd = (v: unknown) => weekdays[num(v)] ?? '';
  const names = (v: unknown) => (Array.isArray(v) ? v.map(String).join(', ') : '');
  const day = (v: unknown) => {
    const [, m, d] = str(v).split('-').map(Number);
    return d && m ? `${d}/${m}` : '';
  };

  return (card: InsightCard): CardText => {
    const p = card.params;
    switch (card.type) {
      case 'today_slow':
        return {
          title: t('today_slow.title'),
          body: t('today_slow.body', { hour: hh(num(p.hour)), actual: agorot(num(p.actual)), pct: absPct(p.pacePct), weekday: wd(p.weekday), expected: agorot(num(p.expected)) }),
          action: t('today_slow.action'),
        };
      case 'today_strong':
        return {
          title: t('today_strong.title'),
          body: t('today_strong.body', { hour: hh(num(p.hour)), actual: agorot(num(p.actual)), pct: absPct(p.pacePct), weekday: wd(p.weekday), projected: agorot(num(p.projected)) }),
          action: t('today_strong.action'),
        };
      case 'yesterday_low':
        return {
          title: t('yesterday_low.title'),
          body: t('yesterday_low.body', { weekday: wd(p.weekday), date: day(p.date), net: agorot(num(p.net)), pct: absPct(p.deviationPct), baseline: agorot(num(p.baseline)) }),
          action: t('yesterday_low.action'),
        };
      case 'yesterday_high':
        return {
          title: t('yesterday_high.title'),
          body: t('yesterday_high.body', { weekday: wd(p.weekday), date: day(p.date), net: agorot(num(p.net)), pct: absPct(p.deviationPct), baseline: agorot(num(p.baseline)) }),
          action: t('yesterday_high.action'),
        };
      case 'week_up':
        return {
          title: t('week_up.title'),
          body: t('week_up.body', { net: agorot(num(p.net)), pct: signed(p.changePct), netPrev: agorot(num(p.netPrev)) }),
          action: t('week_up.action'),
        };
      case 'week_down':
        return {
          title: t('week_down.title'),
          body: t('week_down.body', { net: agorot(num(p.net)), pct: signed(p.changePct), netPrev: agorot(num(p.netPrev)) }),
          action: t('week_down.action'),
        };
      case 'avg_check_up':
        return {
          title: t('avg_check_up.title'),
          body: t('avg_check_up.body', { value: agorot(num(p.avgCheck)), prev: agorot(num(p.avgCheckPrev)), pct: signed(p.changePct) }),
          action: t('avg_check_up.action'),
        };
      case 'avg_check_down':
        return {
          title: t('avg_check_down.title'),
          body: t('avg_check_down.body', { value: agorot(num(p.avgCheck)), prev: agorot(num(p.avgCheckPrev)), pct: signed(p.changePct) }),
          action: t('avg_check_down.action'),
        };
      case 'refunds_up':
        return {
          title: t('refunds_up.title'),
          body: t('refunds_up.body', { count: num(p.count), amount: agorot(num(p.refunds)), pct: pct(p.refundPct, 1), prev: agorot(num(p.refundsPrev)) }),
          action: t('refunds_up.action'),
        };
      case 'discounts_up':
        return {
          title: t('discounts_up.title'),
          body: t('discounts_up.body', { pct: pct(p.discountPct, 1), prev: pct(p.discountPctPrev, 1), amount: agorot(num(p.discounts)) }),
          action: t('discounts_up.action'),
        };
      case 'stock_out':
        return {
          title: t('stock_out.title', { name: str(p.name) }),
          body: t('stock_out.body', { where: p.shopName ? t('inShop', { shop: str(p.shopName) }) : '', perDay: formatQuantity(num(p.perDay)) }),
          action: p.suggested ? t('stock_out.action', { qty: num(p.suggested) }) : undefined,
        };
      case 'stock_low':
        return {
          title: t('stock_low.title', { name: str(p.name) }),
          body: t('stock_low.body', { onHand: formatQuantity(num(p.onHand)), where: p.shopName ? t('inShop', { shop: str(p.shopName) }) : '', days: formatQuantity(num(p.days)) }),
          action: p.suggested ? t('stock_low.action', { qty: num(p.suggested) }) : undefined,
        };
      case 'product_dead':
        return {
          title: p.never
            ? t('product_dead.titleNever', { name: str(p.name), days: num(p.lookbackDays) })
            : t('product_dead.title', { name: str(p.name), days: num(p.days) }),
          body: num(p.onHand) > 0
            ? t('product_dead.bodyStock', { onHand: formatQuantity(num(p.onHand)), value: p.stockValue ? t('stockValue', { value: agorot(num(p.stockValue)) }) : '' })
            : t('product_dead.body'),
          action: p.action === 'sell_off_dont_reorder' ? t('product_dead.actionSellOff') : t('product_dead.action'),
        };
      case 'products_dead_more':
        return {
          title: t('products_dead_more.title', { count: num(p.count) }),
          body: t('products_dead_more.body', { total: num(p.total), days: num(p.days) || 21 }),
          action: t('products_dead_more.action'),
        };
      case 'products_slow':
        return {
          title: t('products_slow.title', { count: num(p.count) }),
          body: t('products_slow.body', { names: names(p.names) }),
          action: t('products_slow.action'),
        };
      case 'product_declining':
        return {
          title: t('product_declining.title', { name: str(p.name) }),
          body: t('product_declining.body', { units: formatQuantity(num(p.units)), unitsPrev: formatQuantity(num(p.unitsPrev)), pct: signed(p.changePct, 0) }),
          action: t('product_declining.action'),
        };
      case 'product_rising':
        return {
          title: t('product_rising.title', { name: str(p.name), pct: absPct(p.changePct) }),
          body: t('product_rising.body', { units: formatQuantity(num(p.units)), unitsPrev: formatQuantity(num(p.unitsPrev)) }),
          action: t('product_rising.action'),
        };
      case 'product_falling':
        return {
          title: t('product_falling.title', { name: str(p.name), pct: absPct(p.changePct) }),
          body: t('product_falling.body', { units: formatQuantity(num(p.units)), unitsPrev: formatQuantity(num(p.unitsPrev)) }),
          action: t('product_falling.action'),
        };
      case 'weak_slot':
        return {
          title: t('weak_slot.title', { weekday: wd(p.weekday), from: hh(num(p.fromHour)), to: hh(num(p.toHour)), pct: absPct(p.deviationPct) }),
          body: t('weak_slot.body', { typical: agorot(num(p.typicalNet)), usual: agorot(num(p.usual)), gap: agorot(num(p.gapPerWeek)) }),
          action: t('weak_slot.action'),
        };
      case 'peak_slot':
        return {
          title: t('peak_slot.title', { weekday: wd(p.weekday), from: hh(num(p.fromHour)), to: hh(num(p.toHour)), pct: absPct(p.deviationPct) }),
          body: t('peak_slot.body', { typical: agorot(num(p.typicalNet)), usual: agorot(num(p.usual)) }),
          action: t('peak_slot.action'),
        };
      case 'menu_plowhorse':
        return p.mode === 'cost'
          ? {
              title: t('menu_plowhorse.title', { name: str(p.name) }),
              body: t('menu_plowhorse.body', { mix: pct(p.menuMix), margin: agorot(num(p.margin)), fc: pct(p.foodCostPct) }),
              action: t('menu_plowhorse.action', { gain: agorot(num(p.gain)) }),
            }
          : {
              title: t('menu_plowhorse.titlePrice', { name: str(p.name) }),
              body: t('menu_plowhorse.bodyPrice', { mix: pct(p.menuMix), price: agorot(num(p.avgPrice)) }),
              action: t('menu_plowhorse.action', { gain: agorot(num(p.gain)) }),
            };
      case 'menu_puzzle':
        return p.mode === 'cost'
          ? {
              title: t('menu_puzzle.title', { name: str(p.name) }),
              body: t('menu_puzzle.body', { mix: pct(p.menuMix, 1), margin: agorot(num(p.margin)) }),
              action: t('menu_puzzle.action'),
            }
          : {
              title: t('menu_puzzle.titlePrice', { name: str(p.name) }),
              body: t('menu_puzzle.bodyPrice', { mix: pct(p.menuMix, 1), price: agorot(num(p.avgPrice)) }),
              action: t('menu_puzzle.action'),
            };
      case 'menu_dogs':
        return {
          title: p.mode === 'cost' ? t('menu_dogs.title', { count: num(p.count) }) : t('menu_dogs.titlePrice', { count: num(p.count) }),
          body: names(p.names),
          action: t('menu_dogs.action'),
        };
      case 'menu_stars':
        return {
          title: t('menu_stars.title'),
          body: p.mode === 'cost' ? t('menu_stars.body', { names: names(p.names) }) : t('menu_stars.bodyPrice', { names: names(p.names) }),
          action: t('menu_stars.action'),
        };
      case 'missing_cost':
        return {
          title: t('missing_cost.title'),
          body: p.mode === 'cost' ? t('missing_cost.body', { count: num(p.count) }) : t('missing_cost.bodyPrice'),
          action: t('missing_cost.action'),
        };
      case 'food_cost_high':
        return {
          title: t('food_cost_high.title', { name: str(p.name), pct: pct(p.foodCostPct) }),
          body: t('food_cost_high.body'),
          action: t('food_cost_high.action'),
        };
      case 'abc_concentration':
        return {
          title: t('abc_concentration.title', { count: num(p.aCount), share: pct(p.aShare) }),
          body: t('abc_concentration.body', { itemShare: pct(p.aItemShare) }),
          action: t('abc_concentration.action'),
        };
      case 'abc_tail':
        return {
          title: t('abc_tail.title', { count: num(p.cCount), share: pct(p.cShare, 1) }),
          body: t('abc_tail.body', { itemShare: pct(p.cItemShare) }),
          action: t('abc_tail.action'),
        };
      case 'pair_bundle':
        return {
          title: t('pair_bundle.title', { a: str(p.a), b: str(p.b) }),
          body: t('pair_bundle.body', { conf: pct(p.confidence), a: str(p.a), b: str(p.b), count: num(p.together), lift: num(p.lift).toFixed(1) }),
          action: t('pair_bundle.action'),
        };
      case 'single_item_baskets':
        return {
          title: t('single_item_baskets.title', { share: pct(p.share) }),
          body: t('single_item_baskets.body'),
          action: t('single_item_baskets.action'),
        };
      case 'cashier_discounts':
        return {
          title: t('cashier_discounts.title', { name: str(p.name) }),
          body: t('cashier_discounts.body', { rate: pct(p.rate, 1), team: pct(p.team, 1), times: num(p.times).toFixed(1) }),
          action: t('cashier_discounts.action'),
        };
      case 'cashier_refunds':
        return {
          title: t('cashier_refunds.title', { name: str(p.name) }),
          body: t('cashier_refunds.body', { rate: pct(p.rate, 1), team: pct(p.team, 1), times: num(p.times).toFixed(1) }),
          action: t('cashier_refunds.action'),
        };
      case 'cashier_voids':
        return {
          title: t('cashier_voids.title', { name: str(p.name) }),
          body: t('cashier_voids.body', { rate: pct(p.rate, 1), team: pct(p.team, 1), times: num(p.times).toFixed(1) }),
          action: t('cashier_voids.action'),
        };
      case 'table_long_open':
        return {
          title: t('table_long_open.title', { number: str(p.number), duration: duration(num(p.minutes)) }),
          body: t('table_long_open.body', { count: num(p.count), number: str(p.number), total: agorot(num(p.total)) }),
          action: t('table_long_open.action'),
        };
      case 'seated_time_change':
        return num(p.changePct) > 0
          ? {
              title: t('seated_time_up.title'),
              body: t('seated_time_up.body', { minutes: num(p.minutes), prev: num(p.minutesPrev), pct: signed(p.changePct, 0) }),
              action: t('seated_time_up.action'),
            }
          : {
              title: t('seated_time_down.title'),
              body: t('seated_time_down.body', { minutes: num(p.minutes), prev: num(p.minutesPrev), pct: signed(p.changePct, 0) }),
              action: t('seated_time_down.action'),
            };
      case 'spend_per_cover_up':
        return {
          title: t('spend_per_cover_up.title'),
          body: t('spend_per_cover_up.body', { value: agorot(num(p.value)), prev: agorot(num(p.prev)), pct: signed(p.changePct) }),
          action: t('spend_per_cover_up.action'),
        };
      case 'spend_per_cover_down':
        return {
          title: t('spend_per_cover_down.title'),
          body: t('spend_per_cover_down.body', { value: agorot(num(p.value)), prev: agorot(num(p.prev)), pct: signed(p.changePct) }),
          action: t('spend_per_cover_down.action'),
        };
      case 'forecast_tomorrow': {
        const parts = [t('forecast_tomorrow.bodyRange', { low: agorot(num(p.low)), high: agorot(num(p.high)) })];
        if (p.peakHour !== null && p.peakHour !== undefined) parts.push(t('forecast_tomorrow.bodyPeak', { hour: hh(num(p.peakHour)) }));
        if (p.accuracy !== null && p.accuracy !== undefined) parts.push(t('forecast_tomorrow.bodyAccuracy', { pct: pct(p.accuracy) }));
        return {
          title: t('forecast_tomorrow.title', { weekday: wd(p.weekday), net: agorot(num(p.net)) }),
          body: parts.join(' '),
          action: t('forecast_tomorrow.action'),
        };
      }
      case 'forecast_week':
        return {
          title: t('forecast_week.title', { total: agorot(num(p.total)) }),
          body: t('forecast_week.body', { pct: signed(p.changePct), lastWeek: agorot(num(p.lastWeek)) }),
        };
      case 'repeat_customers':
        return {
          title: t('repeat_customers.title', { pct: pct(p.repeatPct) }),
          body: t('repeat_customers.body', { netPct: pct(p.repeatNetPct), count: num(p.customers) }),
          action: t('repeat_customers.action'),
        };
      default:
        return { title: t('unknown.title'), body: card.type };
    }
  };
}

function FeedCard({ card, text, onOpen }: { card: InsightCard; text: CardText; onOpen: (section: string) => void }) {
  const t = useTranslations('insights');
  const style = SEVERITY_STYLE[card.severity];
  const severityLabel =
    card.severity === 'critical'
      ? t('severity.critical')
      : card.severity === 'warning'
        ? t('severity.warning')
        : card.severity === 'opportunity'
          ? t('severity.opportunity')
          : card.severity === 'positive'
            ? t('severity.positive')
            : t('severity.info');
  return (
    <Card className="flex h-full gap-3">
      <span
        className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white"
        style={{ backgroundColor: style.color }}
        aria-hidden
      >
        {style.icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div>
          <Chip color={style.color}>{severityLabel}</Chip>
        </div>
        <h3 className="text-[17px] font-semibold leading-snug">{text.title}</h3>
        {text.body ? <p className="text-[15px] leading-snug text-[#3C3C43] dark:text-[#EBEBF5]/80">{text.body}</p> : null}
        {text.action ? (
          <p className="mt-0.5 rounded-xl bg-[#7676801F] px-3 py-2 text-[14px] leading-snug dark:bg-[#7676803D]">
            <span className="font-semibold">{t('feed.action')}: </span>
            {text.action}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => onOpen(card.section)}
          className="mt-auto flex items-center gap-1 self-start pt-1 text-[15px] text-[#007AFF] active:opacity-60 dark:text-[#0A84FF]"
        >
          {t('feed.details')}
          <ArrowLeft className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </Card>
  );
}

export function InsightFeed({ feed, onOpen }: { feed: InsightsFeed; onOpen: (section: string) => void }) {
  const t = useTranslations('insights.feed');
  const text = useCardText();
  const [filter, setFilter] = useState<Filter>('all');
  const cards = useMemo(() => feed.cards.filter((c) => FILTERS[filter].includes(c.severity)), [feed.cards, filter]);
  const count = (f: Filter) => feed.cards.filter((c) => FILTERS[f].includes(c.severity)).length;

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto pb-1">
        <Segmented
          value={filter}
          onChange={setFilter}
          label={t('filter')}
          className="min-w-[360px]"
          options={[
            { id: 'all', label: t('all', { count: count('all') }) },
            { id: 'attention', label: t('attention', { count: count('attention') }) },
            { id: 'opportunity', label: t('opportunities', { count: count('opportunity') }) },
            { id: 'good', label: t('good', { count: count('good') }) },
          ]}
        />
      </div>
      {feed.cards.length === 0 ? (
        <Card>
          <Muted>{t('empty')}</Muted>
        </Card>
      ) : cards.length === 0 ? (
        <Card>
          <Muted>{t('emptyFilter')}</Muted>
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {cards.map((card) => (
            <FeedCard key={card.id} card={card} text={text(card)} onOpen={onOpen} />
          ))}
        </div>
      )}
      {feed.truncated ? <Muted className="px-4 text-[13px]">{t('truncated', { count: feed.cards.length })}</Muted> : null}
    </div>
  );
}
