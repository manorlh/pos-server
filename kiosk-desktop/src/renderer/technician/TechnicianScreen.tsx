/**
 * The technician's screen on Windows — ONE component for every role (P:/specs/windows-setup-parity.md): the kiosk's
 * corner and the manager's menu (staff/StaffLayer.tsx), the till's (the same menu over the till, and "טכנאי" on its lock
 * screen), and the KDS / board / cash host (roles/RoleTechnician.tsx). It is pos-android's "בדיקות ומידע קיוסק"
 * (ui/kiosk/KioskTechnician.kt) in its order and words, with the till technician's ("טכנאי", ui/settings/DiagnosticsScreen.kt),
 * "הגדרות" and "מדפסות" setup slotted into the group they belong to — the same on a kiosk and a till, so they never drift.
 *
 * Everything here is real: a check asks the device or the cloud, a setting is saved (on the device, or in the cloud with
 * a manager's code the cloud checks), and what Windows cannot do (NFC, a SIM, Android's own settings) is not offered —
 * the parity table says why.
 */

import { useEffect, useRef, useState } from 'react';
import type { PreviewModel } from '@kiosk-shared/index';
import type { TechLightView, TechnicianAction, TechnicianActionResult, TechnicianInfo, TechHttpCheck } from '../../shared/bridge';
import { LOG_RANGES, signalLabel, symbologyOf, TECH_TEXT as T, type LogRange } from '../../core/technicianSetup';
import { TERMINAL_CHECK_BYPASS_WARNING } from '../../core/terminalCheckBypass';
import { kiosk } from '../bridge';
import { DISPLAY_SCALE_TEXT, DisplayScaleControl } from '../roles/DisplayScaleControl';
import { updateLine } from '../roles/updateText';
import { DesktopExitMenuButton } from '../desktop/DesktopExit';
import { answered, Btn, NoteBar, Panel, PinPad, Shell, SynqpayPairing, time } from '../staff/staffParts';
import { ForeignRowsPanel, UnpairControl } from '../roles/UnpairControl';
import { deviceLine } from '../../core/pairingMemory';
import { PrinterPicker } from './PrinterPicker';

const LIGHT: Record<TechLightView, string> = { ok: '#16A34A', warn: '#D97706', bad: '#DC2626', unknown: '#9CA3AF' };
const dateTime = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'אף פעם');
const http = (c: TechHttpCheck | null | undefined) => (!c ? '—' : c.code === null ? T.httpFail(c.error ?? '—') : c.ok ? T.httpOk(c.code, c.ms) : T.httpRefused(c.code, c.ms));
const AUDIT: Record<string, string> = { granted: T.auditGranted, wrong: T.auditWrong, locked_out: T.auditLockedOut, locked: T.auditRefused };
const Z_ROLE: Record<string, string> = { independent: T.zIndependent, own_z: T.zOwn, shop_z: T.zShop, till: T.zOwn, cloud: T.zShop };

function Row({ m, label, value, light, ltr = false }: { m: PreviewModel; label: string; value: React.ReactNode; light?: TechLightView | null; ltr?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span style={{ color: m.c.mutedText }}>{label}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-end font-semibold" dir={ltr ? 'ltr' : undefined}>
        {light ? <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: LIGHT[light] }} /> : null}
        <span className="break-all">{value}</span>
      </span>
    </div>
  );
}

function Chip({ label, light }: { label: string; light: TechLightView }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold" style={{ borderColor: LIGHT[light], color: '#111827' }}>
      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: LIGHT[light] }} />
      {label}
    </span>
  );
}

function Field({ m, value, onChange, placeholder, ltr = false, width }: { m: PreviewModel; value: string; onChange: (v: string) => void; placeholder: string; ltr?: boolean; width?: string }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      dir={ltr ? 'ltr' : undefined}
      className={`${width ?? 'min-w-0 flex-1'} rounded border px-2 py-1.5 text-xs`}
      style={{ borderColor: m.c.border, background: m.c.surface, color: m.c.text }}
    />
  );
}

/** A manager's code for a cloud write: what it is for, then the action with the code. */
type ManagerAsk = { title: string; run: (code: string) => TechnicianAction };

export function TechnicianScreen({ m, onClose, onDesktopExit }: { m: PreviewModel; onClose: () => void; onDesktopExit: () => void }) {
  const [info, setInfo] = useState<TechnicianInfo | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [net, setNet] = useState<TechnicianActionResult['network'] | null>(null);
  const [probe, setProbe] = useState<TechnicianActionResult['pinpad'] | null>(null);
  const [restartArmed, setRestartArmed] = useState(false);
  const [manager, setManager] = useState<ManagerAsk | null>(null);
  const top = useRef<HTMLDivElement>(null);
  const refresh = () => void kiosk.technicianInfo().then(setInfo).catch(() => undefined);
  // "בדוק הכל שוב": the facts, the network and the cloud, the pinpad — each its own look, none a charge.
  useEffect(() => {
    refresh();
    setNet(null);
    void kiosk.technicianAction({ type: 'networkCheck' }).then((r) => setNet(r.network ?? null)).catch(() => undefined);
    void kiosk.technicianAction({ type: 'pinpadProbe' }).then((r) => setProbe(r.pinpad ?? null)).catch(() => undefined);
  }, [round]);
  const act = async (a: TechnicianAction, label: string = a.type): Promise<TechnicianActionResult> => {
    setBusy(label);
    const r: TechnicianActionResult = await answered(kiosk.technicianAction(a));
    setBusy(null);
    setNote(r.message ?? (r.ok ? 'בוצע' : 'לא בוצע'));
    top.current?.scrollIntoView({ block: 'nearest' });
    refresh();
    return r;
  };
  const s = info?.setup;
  const title = s?.role === 'kiosk' ? T.titleKiosk : T.titleTill;
  if (!info) return <Shell m={m} title={title} onClose={onClose}>…</Shell>;
  const ident = net?.identity ?? null;
  const pick = <V,>(cloud: V | null | undefined, local: V | null | undefined) => (cloud ?? local ?? '—') as V | string;
  return (
    <Shell m={m} title={title} onClose={onClose}>
      <div ref={top} className="space-y-2">
        <div className="text-sm font-semibold" style={{ color: m.c.mutedText }}>
          {[info.machine?.name, s?.appVersion ?? info.update.current].filter(Boolean).join(' · ')}
        </div>
        <div className="flex flex-wrap gap-2">
          <Btn m={m} onClick={() => setRound((n) => n + 1)}>
            {T.recheck}
          </Btn>
          <Btn m={m} onClick={onClose}>
            {T.back}
          </Btn>
        </div>
      </div>
      {/* Sticky: the answer stays in sight whatever button far down the screen was pressed. */}
      <NoteBar m={m} note={busy ? 'רגע…' : note} />

      {/* "פעולות" — Android's service menu (domain/KioskServiceMenu.kt actions(technician = true)). */}
      <Panel m={m} title={T.actions}>
        <div className="flex flex-wrap gap-2">
          <Btn m={m} onClick={() => void act({ type: 'syncNow' })}>
            {T.sync}
          </Btn>
          <Btn m={m} onClick={() => void act({ type: 'quickSupport' })}>
            {T.support}
          </Btn>
          <Btn m={m} onClick={() => void act({ type: 'pinpadProbe' }).then((r) => setProbe(r.pinpad ?? null))}>
            {T.pinpadCheck}
          </Btn>
          {s?.pinpad.network ? (
            <Btn m={m} onClick={() => document.getElementById('tech-relink')?.scrollIntoView({ block: 'start' })}>
              {T.pinpadRelink}
            </Btn>
          ) : null}
          <Btn m={m} onClick={() => void act({ type: 'printerTest' })}>
            {T.printerTest}
          </Btn>
          {s?.kioskZ ? (
            <Btn m={m} onClick={() => void act({ type: 'kioskZ' })}>
              {T.z}
            </Btn>
          ) : null}
          <Btn
            m={m}
            danger={restartArmed}
            onClick={() => {
              if (!restartArmed) {
                setRestartArmed(true);
                setNote(T.restartConfirm);
                window.setTimeout(() => setRestartArmed(false), 5_000);
                return;
              }
              setRestartArmed(false);
              void act({ type: 'restart' });
            }}
          >
            {restartArmed ? T.restartConfirm : T.restart}
          </Btn>
          {/* Android's "הגדרות Android": on Windows, the desktop (a manager's DESKTOP_EXIT). */}
          <DesktopExitMenuButton onOpen={onDesktopExit} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold" style={{ background: `${m.c.button}1A`, color: m.c.buttonInk, borderRadius: 8 }} />
        </div>
        <div className="text-xs" style={{ color: m.c.mutedText }}>
          {T.autoClose}
        </div>
      </Panel>

      {s?.autostart && !s.autostart.enabled ? (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-amber-50 p-2 text-xs font-semibold text-amber-900">
          <span>
            {T.autostart}: {T.autostartOff}
          </span>
          <Btn m={m} onClick={() => void act({ type: 'autostartOn' })}>
            {T.autostartFix}
          </Btn>
        </div>
      ) : null}

      {s ? (
        <div className="flex flex-wrap gap-2">
          <Chip label={T.lightCloud} light={net ? (net.api?.ok ? 'ok' : net.internet?.ok ? 'warn' : 'bad') : s.lights.cloud} />
          <Chip label={T.lightPinpad} light={probe ? (probe.skipped ? 'unknown' : probe.status?.ok ? 'ok' : 'bad') : s.lights.pinpad} />
          <Chip label={T.lightPrinter} light={s.lights.printer} />
          <Chip label={T.lightMedia(s.lights.mediaFiles, s.lights.mediaMissing)} light={s.lights.media} />
        </div>
      ) : null}

      <IdentityPanel m={m} info={info} ident={ident} netKnown={net !== null} pick={pick} act={act} />

      <Panel m={m} title={T.support_}>
        <Row m={m} label="TeamViewer" value={s?.quickSupportPath ? T.supportFound(s.quickSupportPath) : T.supportMissing} light={s?.quickSupportPath ? 'ok' : 'bad'} />
        <Btn m={m} onClick={() => void act({ type: 'quickSupport' })}>
          {T.supportButton}
        </Btn>
        <SendLogs m={m} act={act} />
      </Panel>

      {/* "גודל תצוגה" (P:/specs/display-scale.md): the one size control, saved on this device over the cloud. */}
      {info.displayScale ? (
        <Panel m={m} title={DISPLAY_SCALE_TEXT.title}>
          <DisplayScaleControl
            view={info.displayScale}
            act={(a) => void act(a)}
            button={(label, onClick, disabled) => (
              <button
                key={label}
                type="button"
                disabled={disabled}
                onClick={onClick}
                className="min-w-[var(--k-target,0px)] px-3 py-1.5 text-xs font-bold disabled:opacity-40"
                style={{ background: `${m.c.button}1A`, color: m.c.buttonInk, borderRadius: 8 }}
              >
                {label}
              </button>
            )}
          />
        </Panel>
      ) : null}

      <Panel m={m} title={T.network}>
        {!net ? <div className="text-xs">בודק…</div> : null}
        {net ? (
          <>
            <Row m={m} label={T.netConnection} value={{ wifi: T.netWifi, ethernet: T.netEthernet, other: T.netOther, none: T.netNone }[net.connection]} light={net.connection === 'none' ? 'bad' : 'ok'} />
            {net.ssid ? <Row m={m} label={T.netSsid} value={net.ssid} ltr /> : null}
            {net.signal !== null ? <Row m={m} label={T.netSignal} value={`${signalLabel(net.signal)} · ${net.signal}%`} light={net.signal >= 50 ? 'ok' : net.signal >= 25 ? 'warn' : 'bad'} /> : null}
            {net.adapters.map((a) => (
              <div key={a.name} className="space-y-0.5 border-t pt-1" style={{ borderColor: m.c.border }}>
                <div className="text-xs font-semibold" dir="ltr">
                  {a.name}
                </div>
                <Row m={m} label={T.netIp} value={a.addresses.join(', ') || '—'} ltr />
                <Row m={m} label={T.netGateway} value={a.gateways.join(', ') || '—'} ltr />
                <Row m={m} label={T.netDns} value={a.dns.join(', ') || '—'} ltr />
              </div>
            ))}
            {net.adapters.length === 0
              ? info.network.interfaces.map((i) => <Row key={i.name + i.address} m={m} label={i.name} value={i.address} ltr />)
              : null}
            <Row m={m} label={T.netInternet} value={http(net.internet)} light={net.internet ? (net.internet.ok ? 'ok' : 'bad') : 'unknown'} />
            <Row m={m} label={T.netApi} value={http(net.api)} light={net.api ? (net.api.ok ? 'ok' : 'bad') : 'unknown'} />
            <Row m={m} label={T.netLan} value={net.lan ? `${net.lan.label}${net.lan.check ? ` — ${http(net.lan.check)}` : ''}` : 'לא מוגדר שרת הדפסות אחר בסניף'} light={net.lan?.check ? (net.lan.check.code !== null ? 'ok' : 'bad') : null} />
          </>
        ) : null}
      </Panel>

      {s ? (
        <Panel m={m} title={T.computer}>
          <Row m={m} label={T.computerSerial} value={s.computer.serial ?? '—'} ltr />
          <Row m={m} label={T.computerModel} value={`${s.computer.hostname} · ${s.computer.cpu} · ${s.computer.memoryGb}GB`} ltr />
          <Row m={m} label={T.computerOs} value={s.computer.os} ltr />
          <Row m={m} label={T.appVersion} value={s.appVersion} ltr />
          <Row
            m={m}
            label={T.computerBattery}
            value={!s.computer.battery || s.computer.battery.percent === null ? 'אין סוללה — מחובר לחשמל' : `${s.computer.battery.percent}%${s.computer.battery.charging ? ' · בטעינה' : ''}`}
            light={s.computer.battery && s.computer.battery.percent !== null ? (s.computer.battery.percent > 20 || s.computer.battery.charging ? 'ok' : 'bad') : null}
          />
          <Row
            m={m}
            label={T.computerClock}
            value={s.computer.clockSkewMs === null ? 'לא נמדד' : Math.abs(s.computer.clockSkewMs) < 2_000 ? 'תקין' : `${s.computer.clockSkewMs > 0 ? 'מקדים' : 'מאחר'} ${Math.round(Math.abs(s.computer.clockSkewMs) / 1000)} שניות`}
            light={s.computer.clockSkewMs === null ? null : Math.abs(s.computer.clockSkewMs) < 60_000 ? 'ok' : 'bad'}
          />
          {s.autostart ? <Row m={m} label={T.autostart} value={s.autostart.enabled ? T.autostartOn : T.autostartOff} light={s.autostart.enabled ? 'ok' : 'bad'} /> : null}
        </Panel>
      ) : null}

      {/* "מדפסות": every printer found, one for everything, the overrides, the width (core/printerPicker.ts). */}
      <PrinterPicker m={m} act={act} />
      <PrinterPanel m={m} info={info} act={act} askManager={setManager} />

      {s ? <DrawerPanel m={m} s={s} act={act} /> : null}

      {s ? (
        <Panel m={m} title={T.kitchen}>
          {s.kitchen.hostsRelay ? <div className="text-xs">המכשיר מדפיס בונים גם עבור מכשירים אחרים בסניף</div> : null}
          {s.kitchen.printers.length === 0 ? <div className="text-xs">{T.kitchenEmpty}</div> : null}
          {s.kitchen.printers.map((k) => (
            <div key={k.id} className="flex flex-wrap items-center justify-between gap-2 border-t pt-1 text-xs" style={{ borderColor: m.c.border }}>
              <span>
                <b>{k.name}</b> · {k.where}
              </span>
              <span className="flex gap-1.5">
                <Btn m={m} onClick={() => void act({ type: 'kitchenTest', printerId: k.id })}>
                  {T.kitchenTest}
                </Btn>
                {k.network ? (
                  <Btn m={m} onClick={() => void act({ type: 'printerWidthTest', printerId: k.id })}>
                    {T.widthTest}
                  </Btn>
                ) : null}
              </span>
            </div>
          ))}
          <Btn m={m} onClick={() => void act({ type: 'kitchenSync' })}>
            {T.kitchenSync}
          </Btn>
        </Panel>
      ) : null}

      <Panel m={m} title={T.pinpad}>
        <div className="text-xs" style={{ color: m.c.mutedText }}>
          {T.pinpadReadonly}
        </div>
        {info.terminal.numberCheckBypass ? <div className="text-xs font-semibold text-amber-700">{TERMINAL_CHECK_BYPASS_WARNING}</div> : null}
        <Row m={m} label={T.pinpadKind} value={probe?.kind ?? info.terminal.kind ?? 'לא מוגדר'} />
        <Row m={m} label={T.pinpadAddress} value={probe?.address ?? info.terminal.address ?? '—'} ltr />
        {probe?.skipped ? <div className="text-xs font-semibold">{probe.skipped}</div> : null}
        {probe?.tcp ? <Row m={m} label={T.pinpadTcp} value={probe.tcp.ok ? `${probe.tcp.ms} ms` : `נכשל — ${probe.tcp.error ?? ''}`} light={probe.tcp.ok ? 'ok' : 'bad'} /> : null}
        {probe?.status ? <Row m={m} label={T.pinpadStatus} value={probe.status.ok ? `עונה · ${probe.status.ms} ms` : `לא ענה — ${probe.status.detail ?? ''}`} light={probe.status.ok ? 'ok' : 'bad'} /> : null}
        {probe?.terminal || probe?.merchant ? <Row m={m} label={T.pinpadTerminal} value={[probe?.terminal, probe?.merchant].filter(Boolean).join(' · ')} /> : null}
        {s?.pinpad.expectedTerminal ? <Row m={m} label="מסוף שהוגדר" value={s.pinpad.expectedTerminal} ltr /> : null}
        <div className="flex flex-wrap gap-2">
          <Btn m={m} onClick={() => void act({ type: 'pinpadProbe' }).then((r) => setProbe(r.pinpad ?? null))}>
            {T.pinpadRecheck}
          </Btn>
          {/* A Nayax C4 on USB: "בדיקת מסופון USB" — the raw replies and the framing (read only). */}
          {s?.pinpad.usb ? (
            <Btn m={m} onClick={() => void act({ type: 'pinpadCheck' })}>
              בדיקת מסופון USB
            </Btn>
          ) : null}
        </div>
      </Panel>

      {s && !s.pinpad.cardless && !info.terminal.synqpay ? <PinpadSetupPanel m={m} s={s} askManager={setManager} /> : null}

      {s?.pinpad.network ? <RelinkPanel m={m} s={s} act={act} /> : null}

      {s?.synqpay ? (
        <Panel m={m} title="מסוף SynqPay">
          <SynqpayPairing m={m} info={s.synqpay} onDone={refresh} />
        </Panel>
      ) : null}

      {s?.cash ? (
        <Panel m={m} title={T.cash}>
          <Row m={m} label="עמדה" value={`${s.cash.station ?? 'עמדה לא ידועה'}${s.cash.address ? ` (${s.cash.address})` : ''}`} light={s.cash.usable ? 'ok' : 'bad'} />
          {!s.cash.usable ? <div className="text-xs text-red-600">{s.cash.reason ?? 'לא זמין'}</div> : null}
          <Btn m={m} onClick={() => void act({ type: 'cashRecheck' })}>
            בדיקה מול מכשיר המזומן
          </Btn>
        </Panel>
      ) : null}
      {s?.cashmag ? (
        <Panel m={m} title="מכשיר מזומן (CashMag)">
          <Row m={m} label="שרת" value={s.cashmag.address} ltr light={s.cashmag.usable ? 'ok' : 'bad'} />
          <Row m={m} label="שם הקיוסק בשרת" value={s.cashmag.terminal} />
          <Row m={m} label="קוד משתמש" value={s.cashmag.userCodeSet ? 'מוגדר' : 'לא מוגדר'} />
          <Row m={m} label="פרוטוקול" value={s.cashmag.protocol} ltr />
          {s.cashmag.lastError ? <div className="text-xs text-red-600">{s.cashmag.lastError}</div> : null}
          <Btn m={m} onClick={() => void act({ type: 'cashmagCheck' })}>
            בדיקת חיבור לשרת CashMag
          </Btn>
        </Panel>
      ) : null}

      <ScannerPanel m={m} />

      <Panel m={m} title={T.update}>
        <Row m={m} label="גרסה נוכחית" value={info.update.current} ltr />
        <Row m={m} label="מצב" value={updateLine(info.update)} />
        <div className="text-xs">
          {info.update.autoInstall
            ? info.update.installWindow
              ? `התקנה אוטומטית בחלון ${info.update.installWindow.start}–${info.update.installWindow.end}, כשאין הזמנה`
              : 'התקנה אוטומטית כשהמכשיר פנוי'
            : 'התקנה ידנית ("התקן עכשיו"); לעולם לא בזמן תשלום'}
        </div>
        <div className="flex gap-2">
          <Btn m={m} onClick={() => void act({ type: 'updateCheck' })}>
            בדוק עכשיו
          </Btn>
          <Btn m={m} onClick={() => void act({ type: 'updateInstall' })}>
            התקן עכשיו
          </Btn>
        </div>
      </Panel>

      {s ? (
        <Panel m={m} title={T.tax}>
          <Row m={m} label={T.taxDealer} value={s.tax.dealer} />
          <Row m={m} label={T.taxVat} value={`${s.tax.vatPercent}%`} ltr />
          <div className="text-xs" style={{ color: m.c.mutedText }}>
            {T.taxNote}
          </div>
        </Panel>
      ) : null}

      <AppLogPanel m={m} act={act} />

      {s ? (
        <Panel m={m} title={T.audit}>
          {s.audit.length === 0 ? <div className="text-xs">{T.auditNone}</div> : null}
          {s.audit.map((e, i) => (
            <Row key={i} m={m} label={dateTime(e.at)} value={AUDIT[e.access] ?? e.access} light={e.access === 'granted' ? 'ok' : 'bad'} />
          ))}
        </Panel>
      ) : null}

      {/* "פעולות מסוכנות": two steps, refused while documents wait for the cloud. */}
      <section className="space-y-1.5 rounded-xl border-2 p-3 text-sm" style={{ borderColor: '#DC2626' }}>
        <h3 className="text-sm font-extrabold text-red-600">{T.danger}</h3>
        <div className="text-xs">{T.dangerNote}</div>
        {/* "רשומות מהמכשיר הקודם": another pairing's rows — held, never sent here; "ייצוא לקובץ". */}
        {info?.foreignRows ? <ForeignRowsPanel rows={info.foreignRows} onDone={refresh} /> : null}
        {s && s.outbox > 0 ? <div className="text-xs font-semibold text-red-600">יש {s.outbox} פריטים שטרם נשלחו לענן</div> : null}
        {/* Why it was refused, what waits, "ניתוק בכל זאת" (core/unpairGuard.ts) — under the button, where the technician looks. */}
        <UnpairControl
          label={T.unpair}
          buttonClassName="min-w-[var(--k-target,0px)] px-3 py-1.5 text-xs font-bold disabled:opacity-40"
          buttonStyle={{ background: '#DC2626', color: '#fff', borderRadius: 8 }}
          onDone={refresh}
          deviceLine={info?.machine ? deviceLine({ posNumber: info.machine.posNumber ?? null, machineName: info.machine.name, machineId: info.machine.machineId, shopName: info.shopName ?? info.machine.shopName }) : null}
        />
      </section>

      <Btn m={m} onClick={onClose}>
        {T.back}
      </Btn>

      {manager ? (
        <div className="contents">
          <PinPad
            m={m}
            title={`${manager.title} — קוד מנהל`}
            onCancel={() => setManager(null)}
            onSubmit={async (code) => {
              const r = await act(manager.run(code));
              if (r.ok) setManager(null);
              return r.ok ? null : (r.message ?? 'לא בוצע');
            }}
          />
        </div>
      ) : null}
    </Shell>
  );
}

type Act = (a: TechnicianAction, label?: string) => Promise<TechnicianActionResult>;

function IdentityPanel({
  m,
  info,
  ident,
  netKnown,
  pick,
  act,
}: {
  m: PreviewModel;
  info: TechnicianInfo;
  ident: NonNullable<TechnicianActionResult['network']>['identity'] | null;
  netKnown: boolean;
  pick: <V>(cloud: V | null | undefined, local: V | null | undefined) => V | string;
  act: Act;
}) {
  const s = info.setup;
  const id = s?.identity;
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState('');
  const [test, setTest] = useState<TechnicianActionResult['server'] | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  return (
    <Panel m={m} title={T.identity}>
      <div className="text-xs" style={{ color: m.c.mutedText }}>
        {ident ? T.sourceCloud : netKnown ? T.sourceLocal : 'בודק…'}
      </div>
      {ident?.tenant ? <Row m={m} label={T.tenant} value={ident.tenant} /> : null}
      <Row m={m} label={T.company} value={pick(ident?.company, id?.company ?? info.companyName)} />
      <Row m={m} label={T.shop} value={pick(ident?.shop, id?.shop ?? info.shopName)} />
      {ident?.branchCode ? <Row m={m} label={T.branchCode} value={ident.branchCode} ltr /> : null}
      {(ident?.area ?? info.areaName) ? <Row m={m} label={T.area} value={(ident?.area ?? info.areaName) as string} /> : null}
      <Row m={m} label={T.machineName} value={pick(ident?.machineName, id?.machineName ?? info.machine?.name)} />
      <Row m={m} label={T.machineId} value={id?.machineId ?? info.machine?.machineId ?? '—'} ltr />
      <Row m={m} label={T.posNumber} value={pick(ident?.posNumber, id?.posNumber ?? info.machine?.posNumber)} ltr />
      <Row m={m} label={T.docPrefix} value={pick(ident?.documentPrefix, id?.documentPrefix)} ltr />
      <Row m={m} label={T.role} value={ident?.role === 'kiosk' ? 'קיוסק' : ident?.role === 'till' ? 'קופה' : (id?.role ?? info.deviceRole ?? '—')} />
      {info.license?.info ? <Row m={m} label={T.license} value={info.license.info.replace(/^סוג רישיון:\s*/, '')} /> : null}
      {info.license?.warning ? <div className="text-xs font-semibold text-amber-700">{info.license.warning}</div> : null}
      <Row m={m} label={T.z_} value={Z_ROLE[ident?.zRole ?? id?.zMode ?? ''] ?? (id?.zMode ?? '—')} />
      {ident?.controllers ? <Row m={m} label={T.controllers} value={ident.controllers.length ? ident.controllers.join(', ') : T.controllersNone} /> : null}
      <Row m={m} label={T.appVersion} value={s?.appVersion ?? info.update.current} ltr />
      <Row m={m} label={T.lastSync} value={dateTime(id?.lastSyncAt ?? info.network.lastBeatOkAt)} />
      <Row m={m} label={T.configVersion} value={id?.configVersion ?? '—'} ltr />
      {id ? <Row m={m} label="מוצרים · עובדים" value={`${id.products} · ${id.staff}`} /> : null}
      {id ? <Row m={m} label="קטלוג עודכן" value={dateTime(id.catalogAt)} /> : null}
      {s ? <Row m={m} label="מכירות ומסמכים בתור לענן" value={String(s.outbox)} light={s.outbox > 0 ? 'warn' : 'ok'} /> : null}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-1" style={{ borderColor: m.c.border }}>
        <Row m={m} label={T.server} value={id?.serverUrl ?? info.network.serverUrl ?? '—'} ltr />
        {!editing ? (
          <Btn
            m={m}
            onClick={() => {
              setEditing(true);
              setUrl(id?.serverUrl ?? info.network.serverUrl ?? 'https://');
              setTest(null);
              setConfirm(null);
            }}
          >
            {T.serverChange}
          </Btn>
        ) : null}
      </div>
      {editing ? (
        <div className="space-y-1.5">
          <div className="flex gap-2">
            <Field m={m} value={url} onChange={(v) => { setUrl(v); setTest(null); setConfirm(null); }} placeholder={T.serverField} ltr />
          </div>
          <div className="flex flex-wrap gap-2">
            <Btn m={m} onClick={() => void act({ type: 'serverTest', url }).then((r) => setTest(r.server ?? null))}>
              {T.serverTest}
            </Btn>
            <Btn
              m={m}
              onClick={() =>
                void act({ type: 'serverSave', url }).then((r) => {
                  setConfirm(r.confirm ?? null);
                  if (r.ok) setEditing(false);
                })
              }
            >
              {T.serverSave}
            </Btn>
            {confirm ? (
              <Btn m={m} danger onClick={() => void act({ type: 'serverSave', url, confirm: true }).then((r) => r.ok && setEditing(false))}>
                {confirm}
              </Btn>
            ) : null}
            <Btn m={m} onClick={() => setEditing(false)}>
              ביטול
            </Btn>
          </div>
          {test ? (
            <>
              <Row m={m} label={T.serverHealth} value={http(test.health)} light={test.health.ok ? 'ok' : 'bad'} />
              {test.health.ok ? <Row m={m} label={T.serverSame} value={test.sameCloud ? T.serverSameYes : T.serverSameNo} light={test.sameCloud ? 'ok' : 'warn'} /> : null}
            </>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}

function SendLogs({ m, act }: { m: PreviewModel; act: Act }) {
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<LogRange>('hour');
  const [text, setText] = useState('');
  if (!open)
    return (
      <Btn m={m} onClick={() => setOpen(true)}>
        {T.logsSend}
      </Btn>
    );
  return (
    <div className="space-y-1.5 rounded-lg border p-2" style={{ borderColor: m.c.border }}>
      <div className="flex flex-wrap gap-2">
        {LOG_RANGES.map((r) => (
          <Btn key={r.id} m={m} onClick={() => setRange(r.id)}>
            {range === r.id ? `✓ ${r.label}` : r.label}
          </Btn>
        ))}
      </div>
      <Field m={m} value={text} onChange={setText} placeholder={T.logsNote} />
      <div className="flex gap-2">
        <Btn m={m} onClick={() => void act({ type: 'sendLogs', range, note: text }).then((r) => r.ok && setOpen(false))}>
          שלח
        </Btn>
        <Btn m={m} onClick={() => setOpen(false)}>
          ביטול
        </Btn>
      </div>
    </div>
  );
}

function PrinterPanel({ m, info, act, askManager }: { m: PreviewModel; info: TechnicianInfo; act: Act; askManager: (a: ManagerAsk) => void }) {
  const s = info.setup;
  const [queue, setQueue] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('9100');
  const [scan, setScan] = useState<TechnicianActionResult['printers'] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  return (
    <Panel m={m} title={T.printer}>
      {info.printer.usb ? <div className="text-xs font-semibold">{info.printer.usb}</div> : null}
      <Row m={m} label="מדפסת" value={`${info.printer.target} · ${info.printer.health}`} light={s?.lights.printer ?? null} />
      {s?.printer.branch ? <Row m={m} label={T.printerBranch} value={s.printer.branch} ltr /> : null}
      {s ? <Row m={m} label={T.printerPaper} value={T.printerWidth(s.printer.widthDots, s.printer.cut)} /> : null}
      {s ? <Row m={m} label={T.printerLastOk} value={dateTime(s.printer.lastOkAt)} /> : null}
      {s?.printer.lastFailure ? <Row m={m} label={T.printerLastFailure} value={s.printer.lastFailure} light="bad" /> : null}
      <div className="flex flex-wrap gap-2">
        <Btn m={m} onClick={() => void act({ type: 'printerTest' })}>
          {T.printTest}
        </Btn>
        <Btn m={m} onClick={() => void act({ type: 'printerWidthTest' })}>
          {T.widthTest}
        </Btn>
      </div>
      <div className="text-xs" style={{ color: m.c.mutedText }}>
        {T.widthTestNote}
      </div>
      {/* "המדפסת של הקופה — הגדרה מקומית" (Android ReceiptDefaultCard): אוטומטי / USB-Windows / רשת (IP:פורט). */}
      <div className="space-y-1.5 border-t pt-1.5" style={{ borderColor: m.c.border }}>
        <div className="text-xs font-bold">המדפסת של המכשיר — הגדרה ידנית</div>
        <div className="text-xs" style={{ color: m.c.mutedText }}>
          מדפסות Windows: {info.printer.queues.join(' · ') || '—'}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Btn m={m} onClick={() => void act({ type: 'setPrinter', transport: 'spooler', queueName: '' })}>
            {info.printer.auto ? '✓ ' : ''}אוטומטי (USB)
          </Btn>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Field m={m} value={queue} onChange={setQueue} placeholder="שם תור המדפסת ב-Windows" />
          <Btn m={m} onClick={() => void act({ type: 'setPrinter', transport: 'spooler', queueName: queue.trim() })}>
            USB / Windows
          </Btn>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Field m={m} value={host} onChange={setHost} placeholder="192.168.1.50" ltr />
          <Field m={m} value={port} onChange={(v) => setPort(v.replace(/\D/g, '').slice(0, 5))} placeholder="9100" ltr width="w-16" />
          <Btn m={m} onClick={() => void act({ type: 'setPrinter', transport: 'tcp', host: host.trim(), port: Number(port) || 9100 })}>
            רשת (IP:פורט)
          </Btn>
        </div>
      </div>
      {info.receipts ? (
        // "מדפסת לקבלות ולמסמכים": another till's printer the cloud offers this one (bill-print-other-till).
        <div className="flex flex-col gap-1 border-t pt-1.5" style={{ borderColor: m.c.border }}>
          <div className="text-xs font-bold">מדפסת לקבלות ולמסמכים</div>
          {info.receipts.scope ? <div className="text-xs">{info.receipts.scope}</div> : null}
          <div className="flex flex-wrap items-center gap-2">
            {info.receipts.options.map((o) => (
              <Btn key={o.id} m={m} onClick={() => void act({ type: 'setReceiptPrinter', id: o.id })}>
                {info.receipts!.choice === o.id ? `✓ ${o.label}` : o.label}
              </Btn>
            ))}
            <Btn m={m} onClick={() => void act({ type: 'setReceiptPrinter', id: null })}>
              {info.receipts.choice === null ? '✓ ' : ''}חזור להגדרת הענן
            </Btn>
          </div>
        </div>
      ) : null}
      {/* "חיפוש מדפסות ברשת" (Android PrinterDiscoveryPanel): port 9100 on the /24, status only. */}
      <div className="space-y-1.5 border-t pt-1.5" style={{ borderColor: m.c.border }}>
        <div className="text-xs font-bold">{T.discovery}</div>
        <Btn
          m={m}
          onClick={() => {
            setScanning(true);
            void act({ type: 'printerScan' }).then((r) => {
              setScanning(false);
              setScan(r.printers ?? null);
            });
          }}
        >
          {scanning ? 'מחפש…' : T.discovery}
        </Btn>
        {scan ? (
          <div className="space-y-1">
            <div className="text-xs" dir="ltr">
              {scan.subnet}
            </div>
            {scan.found.length === 0 ? <div className="text-xs">{T.discoveryNone}</div> : null}
            {scan.found.map((p) => {
              const key = `${p.host}:${p.port}`;
              return (
                <div key={key} className="space-y-1 rounded-lg border p-1.5 text-xs" style={{ borderColor: m.c.border }}>
                  <div className="flex items-center justify-between gap-2">
                    <span dir="ltr" className="font-bold">
                      {key}
                    </span>
                    <span>
                      {p.health}
                      {p.known ? ` · ${p.known}` : ''}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Btn m={m} onClick={() => void act({ type: 'setPrinter', transport: 'tcp', host: p.host, port: p.port })}>
                      {T.discoveryUse}
                    </Btn>
                    {!p.known ? (
                      <>
                        <Field m={m} value={names[key] ?? ''} onChange={(v) => setNames((n) => ({ ...n, [key]: v }))} placeholder="שם המדפסת" width="w-28" />
                        <Btn m={m} onClick={() => askManager({ title: `${T.discoveryAdd} (בונים)`, run: (code) => ({ type: 'printerAdd', host: p.host, port: p.port, name: names[key] ?? '', purpose: 'kitchen', code }) })}>
                          {T.discoveryAdd} — בונים
                        </Btn>
                        <Btn m={m} onClick={() => askManager({ title: `${T.discoveryAdd} (קבלות)`, run: (code) => ({ type: 'printerAdd', host: p.host, port: p.port, name: names[key] ?? '', purpose: 'receipt', code }) })}>
                          {T.discoveryAdd} — קבלות
                        </Btn>
                      </>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

function DrawerPanel({ m, s, act }: { m: PreviewModel; s: NonNullable<TechnicianInfo['setup']>; act: Act }) {
  return (
    <Panel m={m} title={T.drawer}>
      <Row m={m} label={T.drawerVia} value={s.drawer.via} />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span style={{ color: m.c.mutedText }}>{T.drawerPin}</span>
        {([2, 5] as const).map((pin) => (
          <Btn key={pin} m={m} onClick={() => void act({ type: 'drawerSet', pin, onMs: s.drawer.onMs })}>
            {s.drawer.pin === pin ? `✓ פין ${pin}` : `פין ${pin}`}
          </Btn>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span style={{ color: m.c.mutedText }}>{T.drawerPulse}</span>
        {s.drawer.pulses.map((ms) => (
          <Btn key={ms} m={m} onClick={() => void act({ type: 'drawerSet', pin: s.drawer.pin, onMs: ms })}>
            {s.drawer.onMs === ms ? `✓ ${ms} ms` : `${ms} ms`}
          </Btn>
        ))}
      </div>
      <Btn m={m} onClick={() => void act({ type: 'drawerTest' })}>
        {T.drawerTest}
      </Btn>
      <div className="text-xs" style={{ color: m.c.mutedText }}>
        {s.drawer.audited ? 'נרשם ביומן המגירה כפתיחת בדיקה של טכנאי' : 'נשלחת פתיחה דרך המדפסת'}
      </div>
    </Panel>
  );
}

function PinpadSetupPanel({ m, s, askManager }: { m: PreviewModel; s: NonNullable<TechnicianInfo['setup']>; askManager: (a: ManagerAsk) => void }) {
  const [host, setHost] = useState(s.pinpad.host ?? '');
  const [port, setPort] = useState(s.pinpad.port ? String(s.pinpad.port) : '');
  return (
    <Panel m={m} title={T.pinpadSetup}>
      <div className="text-xs" style={{ color: m.c.mutedText }}>
        מסופון Nayax ברשת או בכבל USB — נשמר בענן להגדרות הקופה, בקוד מנהל
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Field m={m} value={host} onChange={setHost} placeholder={T.pinpadSetupHost} ltr />
        <Field m={m} value={port} onChange={(v) => setPort(v.replace(/\D/g, '').slice(0, 5))} placeholder="8080" ltr width="w-16" />
        <Btn m={m} onClick={() => askManager({ title: T.pinpadSetup, run: (code) => ({ type: 'pinpadSetup', connection: 'lan', host: host.trim(), port: port ? Number(port) : null, code }) })}>
          {T.pinpadSetupSave}
        </Btn>
      </div>
      <Btn m={m} onClick={() => askManager({ title: 'חיבור USB', run: (code) => ({ type: 'pinpadSetup', connection: 'usb', code }) })}>
        {T.pinpadSetupUsb}
      </Btn>
    </Panel>
  );
}

function RelinkPanel({ m, s, act }: { m: PreviewModel; s: NonNullable<TechnicianInfo['setup']>; act: Act }) {
  const [found, setFound] = useState<TechnicianActionResult['pinpads'] | null>(null);
  const [searching, setSearching] = useState(false);
  return (
    <div id="tech-relink">
      <Panel m={m} title={T.relink}>
        <div className="text-xs" style={{ color: m.c.mutedText }}>
          {T.relinkHint}
        </div>
        <Row m={m} label={T.relinkAuto} value={s.pinpad.auto} />
        {s.pinpad.lastMove ? <Row m={m} label={T.relinkLast} value={s.pinpad.lastMove} ltr /> : null}
        <Row m={m} label="הכתובת הנוכחית" value={`${s.pinpad.host}:${s.pinpad.port}`} ltr />
        <Row m={m} label="טביעת התעודה (SHA-256)" value={s.pinpad.certPin ?? 'עוד לא הוצמדה'} ltr />
        {s.pinpad.certPin ? (
          <Btn m={m} onClick={() => void act({ type: 'pinpadPinReset' })}>
            איפוס הצמדת התעודה
          </Btn>
        ) : null}
        <Btn
          m={m}
          onClick={() => {
            setSearching(true);
            void act({ type: 'pinpadSearch' }).then((r) => {
              setSearching(false);
              setFound(r.pinpads ?? []);
            });
          }}
        >
          {searching ? 'סורק את הרשת…' : T.relinkSearch}
        </Btn>
        {found?.length === 0 ? <div className="text-xs">{T.relinkNone}</div> : null}
        {found?.map((p) => (
          <div key={`${p.host}:${p.port}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-1.5 text-xs" style={{ borderColor: m.c.border }}>
            <span>
              <b dir="ltr">
                {p.host}:{p.port}
              </b>{' '}
              · מסוף {p.terminal ?? '—'}
              {p.merchant ? ` · ${p.merchant}` : ''} · {p.match === 'same' ? T.relinkSame : p.match === 'other' ? T.relinkOther(p.terminal ?? '—') : ''}
            </span>
            {p.match !== 'other' ? (
              <Btn m={m} onClick={() => void act({ type: 'pinpadLink', host: p.host, port: p.port })}>
                {T.relinkChoose}
              </Btn>
            ) : null}
          </div>
        ))}
      </Panel>
    </div>
  );
}

/** "סורק ברקוד": a keyboard-wedge scan caught while the test is on (and kept from the screen under it). */
function ScannerPanel({ m }: { m: PreviewModel }) {
  const [on, setOn] = useState(false);
  const [last, setLast] = useState<{ code: string; at: number } | null>(null);
  useEffect(() => {
    if (!on) return;
    let buf = '';
    let at = 0;
    const onKey = (e: KeyboardEvent) => {
      const now = Date.now();
      if (now - at > 300) buf = '';
      at = now;
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (buf.length >= 3) setLast({ code: buf, at: now });
        buf = '';
      } else if (e.key.length === 1) {
        buf += e.key;
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [on]);
  return (
    <Panel m={m} title={T.scanner}>
      <div className="text-xs" style={{ color: m.c.mutedText }}>
        {T.scannerSubtitle}
      </div>
      <Row m={m} label={T.scannerLast} value={last ? `${last.code} · ${time(last.at)}` : on ? T.scannerWaiting : '—'} ltr light={last ? 'ok' : null} />
      {last ? <Row m={m} label={T.scannerType} value={symbologyOf(last.code)} /> : null}
      <Btn m={m} onClick={() => setOn((v) => !v)}>
        {on ? T.scannerStop : T.scannerStart}
      </Btn>
    </Panel>
  );
}

function AppLogPanel({ m, act }: { m: PreviewModel; act: Act }) {
  const [lines, setLines] = useState<string[] | null>(null);
  return (
    <Panel m={m} title={T.appLog}>
      <Btn m={m} onClick={() => void act({ type: 'appLog' }).then((r) => setLines(r.log ?? []))}>
        {T.appLog}
      </Btn>
      {lines ? (
        <div className="max-h-56 overflow-y-auto rounded bg-black/5 p-1.5 font-mono text-[10px] leading-snug" dir="ltr">
          {lines.length === 0 ? 'אין שורות בשעה האחרונה' : lines.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      ) : null}
    </Panel>
  );
}
