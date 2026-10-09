/**
 * The bridge's window ("R2M POS · גשר לדפדפן", from the tray; docs/SPEC_KIOSK.md §28): the code to
 * type in the browser page, the paired page and the kiosk machine it serves, the card terminal and
 * the printer (with a test), the cash drawer, "פתיחה בהפעלה" (the browser in kiosk mode — leaving it
 * needs the technician's code), the sites allowed to call the bridge, updates, and the call log.
 * Outside Electron (`npm run dev:web`, bridge.html) a demo view stands in.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { CreditCard, Globe, KeyRound, Link2, MonitorPlay, Printer, RefreshCw, ScrollText, ShieldCheck, Wrench } from 'lucide-react';
import type { BridgeActionResult, BridgeWindowAction, BridgeWindowApi, BridgeWindowView } from '../../shared/bridgeWindow';

const demo: BridgeWindowView = {
  version: 'dev',
  port: 47615,
  listenError: null,
  pairing: { paired: false, role: null, roleLabel: null, origin: null, url: null, pairedAt: null, device: null },
  code: { code: '482913', secondsLeft: 540, lockedSeconds: 0 },
  link: null,
  card: null,
  shift: null,
  outbox: 0,
  printer: {
    target: 'Windows: SNBC BTP-880 (USB · אוטומטי)',
    transport: 'spooler',
    queueName: null,
    host: null,
    port: null,
    health: 'unknown',
    lastError: null,
    lastOkAt: null,
    auto: true,
    usb: 'מדפסת USB: SNBC BTP-880 מחוברת',
  },
  queues: ['SNBC BTP-880', 'Microsoft Print to PDF'],
  drawer: false,
  origins: { defaults: ['https://pos-cloud-app.vercel.app', 'http://localhost:3002'], extra: [] },
  launcher: { enabled: false, browser: 'auto', url: null, role: 'kiosk', phase: 'off', text: 'כבוי', runningBrowser: null },
  update: null,
  calls: [],
};

const api: BridgeWindowApi = window.r2mBridge ?? {
  view: async () => demo,
  action: async () => ({ ok: true }),
  on: () => () => undefined,
};

function Card({ title, icon, children, trailing }: { title: string; icon: ReactNode; children: ReactNode; trailing?: ReactNode }) {
  return (
    <section className="space-y-3 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-extrabold">
          {icon}
          {title}
        </h2>
        {trailing}
      </div>
      {children}
    </section>
  );
}

function Row({ k, v, ltr }: { k: string; v: ReactNode; ltr?: boolean }) {
  return (
    <>
      <dt className="text-neutral-500">{k}</dt>
      <dd className="font-semibold" dir={ltr ? 'ltr' : undefined} style={ltr ? { textAlign: 'end' } : undefined}>
        {v ?? '—'}
      </dd>
    </>
  );
}

const btn = 'inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-sm font-bold disabled:opacity-50';
const soft = `${btn} bg-blue-50 text-blue-700 hover:bg-blue-100`;
const danger = `${btn} bg-red-50 text-red-700 hover:bg-red-100`;
const field = 'rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-600';

function time(ms: number | null | undefined): string {
  return ms ? new Date(ms).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
}

export function BridgeWindow() {
  const [v, setV] = useState<BridgeWindowView | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pin, setPin] = useState('');
  const [pinFor, setPinFor] = useState<null | 'exitKiosk' | 'quit' | { add: string } | { remove: string }>(null);
  const [newOrigin, setNewOrigin] = useState('');
  const [link, setLink] = useState('');
  const [tcp, setTcp] = useState({ host: '', port: '9100' });

  useEffect(() => {
    void api.view().then(setV);
    return api.on(setV);
  }, []);

  const run = async (a: BridgeWindowAction): Promise<BridgeActionResult> => {
    const r = await api.action(a);
    setMsg(r.message ? { ok: r.ok, text: r.message } : r.ok ? null : { ok: false, text: 'הפעולה נכשלה' });
    void api.view().then(setV);
    return r;
  };

  if (!v) return null;
  const paired = v.pairing.paired;

  return (
    <div dir="rtl" className="mx-auto max-w-3xl space-y-4 p-5 text-neutral-900">
      <header className="flex items-center justify-between gap-3">
        <div>
          <div className="text-2xl font-black tracking-tight">
            R2M <span className="text-blue-600">POS</span> <span className="text-lg font-bold text-neutral-500">· גשר לדפדפן</span>
          </div>
          <p className="text-xs text-neutral-500">
            גרסה {v.version} · {v.port ? <span dir="ltr">http://127.0.0.1:{v.port}</span> : <span className="font-bold text-red-700">{v.listenError ?? 'לא מאזין'}</span>}
          </p>
        </div>
        <button type="button" className={soft} onClick={() => void run({ type: 'hide' })}>
          הסתרה (ממשיך לרוץ)
        </button>
      </header>

      {msg ? <p className={`rounded-xl p-3 text-sm font-semibold ${msg.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}>{msg.text}</p> : null}

      <Card title={paired ? `מצומד ל${v.pairing.roleLabel ?? 'דף'}` : 'צימוד עם הדפדפן'} icon={<KeyRound className="h-5 w-5 text-blue-600" />}>
        {v.code ? (
          <div className="flex flex-wrap items-center gap-4 rounded-xl bg-blue-50 p-4">
            <div dir="ltr" className="font-mono text-4xl font-black tracking-[0.3em]">
              {v.code.lockedSeconds > 0 ? '······' : `${v.code.code.slice(0, 3)} ${v.code.code.slice(3)}`}
            </div>
            <div className="text-sm text-neutral-600">
              {v.code.lockedSeconds > 0 ? `נעול ל-${v.code.lockedSeconds} שניות אחרי ניסיונות שגויים` : `הקלידו את הקוד בדף (ניהול הקיוסק / המסך ← "גשר Windows"). בתוקף עוד ${Math.ceil(v.code.secondsLeft / 60)} דק׳, לשימוש אחד.`}
            </div>
          </div>
        ) : null}
        {paired ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <Row k="אתר" v={v.pairing.origin} ltr />
            <Row k="דף" v={v.pairing.url} ltr />
            <Row k="דפדפן" v={v.pairing.device} />
            <Row k="מאז" v={v.pairing.pairedAt ? new Date(v.pairing.pairedAt).toLocaleString('he-IL') : null} />
          </dl>
        ) : (
          <p className="text-sm text-neutral-600">פתחו את הקיוסק / מסך המטבח / מסך המוכן בדפדפן במחשב הזה. עם "פתיחה בהפעלה" הגשר פותח אותו בעצמו ומצמד אוטומטית.</p>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={soft} onClick={() => void run({ type: 'newCode' })}>
            קוד צימוד חדש
          </button>
          {paired ? (
            <button type="button" className={danger} onClick={() => void run({ type: 'unpair' })}>
              ביטול הצימוד
            </button>
          ) : null}
        </div>
      </Card>

      <Card title="המכשיר בענן" icon={<Link2 className="h-5 w-5 text-blue-600" />}>
        {v.link ? (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <Row k="מכשיר" v={[v.link.machineName, v.link.posNumber ? `קופה ${v.link.posNumber}` : null].filter(Boolean).join(' · ')} />
              <Row k="סניף" v={[v.link.companyName, v.link.shopName].filter(Boolean).join(' · ') || null} />
              <Row k="משמרת" v={v.shift ? (v.shift.open ? `פתוחה (${v.shift.number})` : 'סגורה') : '—'} />
              <Row k="ממתינים לענן" v={v.outbox} />
              <Row k="סנכרון אחרון" v={time(v.link.lastSyncOkAt)} />
              <Row k="מזהה" v={v.link.machineId} ltr />
            </dl>
            <button type="button" className={danger} onClick={() => void run({ type: 'unlink' })}>
              ניתוק מהמכשיר
            </button>
          </>
        ) : (
          <p className="text-sm text-neutral-600">הדף המצומד מעביר את פרטי המכשיר מיד אחרי הצימוד. הגשר משתמש בהגדרות התשלום וההדפסה של המכשיר הזה בענן.</p>
        )}
      </Card>

      <Card
        title="מסופון אשראי"
        icon={<CreditCard className="h-5 w-5 text-blue-600" />}
        trailing={
          <button type="button" className={soft} onClick={() => void run({ type: 'checkTerminal' })}>
            בדיקת מסופון (קריאה בלבד)
          </button>
        }
      >
        {v.card ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <Row k="סוג" v={v.card.kind === 'nayax_lan' ? 'Nayax LAN' : v.card.kind === 'nayax_usb' ? 'Nayax USB' : v.card.kind === 'synqpay' ? 'SynqPay' : v.card.kind} />
            <Row k="כתובת" v={v.card.address} ltr />
            <Row k="מצב" v={v.card.ready ? 'מוכן' : (v.card.reason ?? v.card.state)} />
            <Row k="ממתינים לבירור" v={v.card.unresolved} />
          </dl>
        ) : (
          <p className="text-sm text-neutral-600">רק לקיוסק מקושר: המסופון נלקח מהגדרות התשלום של הקיוסק בענן.</p>
        )}
      </Card>

      <Card
        title="מדפסת"
        icon={<Printer className="h-5 w-5 text-blue-600" />}
        trailing={
          <button type="button" className={soft} onClick={() => void run({ type: 'testPrint' })}>
            הדפסת בדיקה
          </button>
        }
      >
        <p className={`text-sm font-semibold ${/מחוברת$/.test(v.printer.usb) ? 'text-emerald-700' : /דרייבר/.test(v.printer.usb) ? 'text-amber-700' : 'text-neutral-600'}`}>{v.printer.usb}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <Row k="יעד" v={v.printer.target} />
          <Row k="מצב" v={v.printer.health} />
          <Row k="הודפס לאחרונה" v={time(v.printer.lastOkAt)} />
          {v.printer.lastError ? <Row k="שגיאה" v={v.printer.lastError} /> : null}
        </dl>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select
            className={field}
            value={v.printer.transport === 'spooler' ? (v.printer.queueName ?? '') : ''}
            onChange={(e) => void run({ type: 'setPrinter', transport: 'spooler', queueName: e.target.value })}
          >
            <option value="">אוטומטי — מדפסת ה-USB המחוברת</option>
            {v.queues.map((q) => (
              <option key={q} value={q}>
                {q}
              </option>
            ))}
          </select>
          <button type="button" className={soft} onClick={() => void run({ type: 'refreshQueues' })}>
            <RefreshCw className="h-4 w-4" />
          </button>
          <span className="text-neutral-400">או רשת:</span>
          <input dir="ltr" className={`${field} w-36`} placeholder="192.168.1.50" value={tcp.host} onChange={(e) => setTcp({ ...tcp, host: e.target.value })} />
          <input dir="ltr" className={`${field} w-20`} value={tcp.port} onChange={(e) => setTcp({ ...tcp, port: e.target.value })} />
          <button type="button" className={soft} disabled={!tcp.host.trim()} onClick={() => void run({ type: 'setPrinter', transport: 'tcp', host: tcp.host, port: Number(tcp.port) || 9100 })}>
            שמירה
          </button>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={v.drawer} onChange={(e) => void run({ type: 'setDrawer', on: e.target.checked })} />
          מגירת כסף מחוברת למדפסת
          {v.drawer ? (
            <button type="button" className={soft} onClick={() => void run({ type: 'openDrawer' })}>
              פתיחת מגירה
            </button>
          ) : null}
        </label>
      </Card>

      <Card title="פתיחה בהפעלה (מצב קיוסק)" icon={<MonitorPlay className="h-5 w-5 text-blue-600" />}>
        <p className="text-sm text-neutral-600">
          אחרי הפעלת Windows הגשר פותח את הדף ב-{v.launcher.runningBrowser === 'edge' ? 'Edge' : v.launcher.runningBrowser === 'chrome' ? 'Chrome' : 'Chrome / Edge'} במסך מלא, בפרופיל משלו, ופותח אותו שוב אם נסגר. מצב: <b>{v.launcher.text}</b>
        </p>
        <div className="grid gap-2 text-sm sm:grid-cols-[auto_1fr]">
          <label className="flex items-center gap-2 font-semibold">
            <input type="checkbox" checked={v.launcher.enabled} onChange={(e) => void run({ type: 'setLauncher', enabled: e.target.checked })} />
            פתיחה בהפעלה
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <select className={field} value={v.launcher.browser} onChange={(e) => void run({ type: 'setLauncher', browser: e.target.value as 'auto' | 'edge' | 'chrome' })}>
              <option value="auto">אוטומטי (Chrome, אחרת Edge)</option>
              <option value="chrome">Chrome</option>
              <option value="edge">Edge</option>
            </select>
            <select className={field} value={v.launcher.role} onChange={(e) => void run({ type: 'setLauncher', role: e.target.value as 'kiosk' | 'kds' | 'order_status_board' })}>
              <option value="kiosk">קיוסק</option>
              <option value="kds">מסך מטבח (KDS)</option>
              <option value="order_status_board">מסך מוכן / לא מוכן</option>
            </select>
          </div>
          <span className="text-neutral-500">כתובת</span>
          <div dir="ltr" className="break-all font-mono text-xs">
            {v.launcher.url ?? '—'}
          </div>
          <span className="text-neutral-500">קישור מהדשבורד</span>
          <div className="flex gap-2">
            <input dir="ltr" className={`${field} min-w-0 flex-1`} placeholder="https://…/k#pair=AB12CD34" value={link} onChange={(e) => setLink(e.target.value)} />
            <button
              type="button"
              className={soft}
              disabled={!link.trim()}
              onClick={async () => {
                const r = await run({ type: 'useDashboardLink', link });
                if (r.ok) setLink('');
              }}
            >
              שימוש
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={soft} onClick={() => void run({ type: 'openBrowserNow' })}>
            פתח עכשיו
          </button>
          <button type="button" className={danger} onClick={() => setPinFor('exitKiosk')}>
            יציאה ממצב קיוסק…
          </button>
        </div>
        <p className="text-xs text-neutral-500">מתוך הדפדפן במצב קיוסק: Ctrl+Alt+Shift+B פותח את החלון הזה.</p>
      </Card>

      <Card title="אתרים מורשים" icon={<ShieldCheck className="h-5 w-5 text-blue-600" />}>
        <p className="text-sm text-neutral-600">רק דפים מהאתרים האלה יכולים לפנות לגשר, ורק אחרי צימוד; כל בקשה חתומה.</p>
        <ul className="space-y-1 text-sm" dir="ltr">
          {v.origins.defaults.map((o) => (
            <li key={o} className="font-mono text-xs">
              {o}
            </li>
          ))}
          {v.origins.extra.map((o) => (
            <li key={o} className="flex items-center justify-between font-mono text-xs">
              {o}
              <button type="button" className="text-red-700 underline" onClick={() => setPinFor({ remove: o })}>
                הסרה
              </button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <input dir="ltr" className={`${field} min-w-0 flex-1`} placeholder="https://dashboard.example.com" value={newOrigin} onChange={(e) => setNewOrigin(e.target.value)} />
          <button type="button" className={soft} disabled={!newOrigin.trim()} onClick={() => setPinFor({ add: newOrigin })}>
            הוספה…
          </button>
        </div>
      </Card>

      <Card
        title="עדכונים"
        icon={<Wrench className="h-5 w-5 text-blue-600" />}
        trailing={
          <div className="flex gap-2">
            <button type="button" className={soft} onClick={() => void run({ type: 'checkUpdate' })}>
              בדוק עכשיו
            </button>
            {v.update?.phase === 'ready' ? (
              <button type="button" className={soft} onClick={() => void run({ type: 'installUpdate' })}>
                התקן עכשיו
              </button>
            ) : null}
          </div>
        }
      >
        <p className="text-sm text-neutral-600">
          {v.update ? `${v.update.current} · ${v.update.available ? `זמינה ${v.update.available}` : 'עדכנית'}${v.update.message ? ` · ${v.update.message}` : ''}` : 'עדכונים מהענן יתחילו אחרי קישור מכשיר.'}
        </p>
      </Card>

      <Card title="יומן פניות" icon={<ScrollText className="h-5 w-5 text-blue-600" />}>
        {v.calls.length === 0 ? (
          <p className="text-sm text-neutral-500">אין עדיין</p>
        ) : (
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full text-xs" dir="ltr">
              <tbody>
                {v.calls.map((c, i) => (
                  <tr key={`${c.at}-${i}`} className="border-t border-neutral-100">
                    <td className="py-1 pe-2 tabular-nums text-neutral-500">{time(c.at)}</td>
                    <td className="pe-2 font-mono">
                      {c.method} {c.path}
                    </td>
                    <td className={`pe-2 font-bold ${c.status >= 400 ? 'text-red-700' : 'text-emerald-700'}`}>{c.status}</td>
                    <td className="pe-2 text-neutral-500">{c.ms} ms</td>
                    <td className="truncate text-neutral-500">{c.note ?? c.origin ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <footer className="flex items-center justify-between pb-6 text-xs text-neutral-500">
        <span className="flex items-center gap-1">
          <Globe className="h-3.5 w-3.5" /> POWERED BY R2M POS
        </span>
        <button type="button" className="underline" onClick={() => setPinFor('quit')}>
          יציאה מהגשר…
        </button>
      </footer>

      {pinFor ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-5 text-center shadow-2xl">
            <h3 className="text-lg font-extrabold">קוד טכנאי</h3>
            <input
              autoFocus
              type="password"
              inputMode="numeric"
              maxLength={8}
              className={`${field} mx-auto block w-40 text-center font-mono text-2xl tracking-[0.3em]`}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            />
            <div className="flex justify-center gap-2">
              <button
                type="button"
                className={soft}
                onClick={() => {
                  setPinFor(null);
                  setPin('');
                }}
              >
                ביטול
              </button>
              <button
                type="button"
                className={`${btn} bg-blue-600 text-white`}
                disabled={pin.length < 4}
                onClick={async () => {
                  const p = pin;
                  const what = pinFor;
                  setPin('');
                  setPinFor(null);
                  if (what === 'exitKiosk') await run({ type: 'exitKioskMode', pin: p });
                  else if (what === 'quit') await run({ type: 'quit', pin: p });
                  else if ('add' in what) {
                    const r = await run({ type: 'addOrigin', origin: what.add, pin: p });
                    if (r.ok) setNewOrigin('');
                  } else await run({ type: 'removeOrigin', origin: what.remove, pin: p });
                }}
              >
                אישור
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
