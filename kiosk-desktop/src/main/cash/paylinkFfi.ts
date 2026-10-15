/**
 * The vendor's DLL (AESImhei64.dll, installed separately — P:/specs/cash-paylink.md §9ב) bound with
 * koffi: the function signatures and struct layouts exactly as AESImhei.h declares them (interface
 * version 0x10008; default x64 alignment — the header sets no packing):
 *
 *   AcceptorCoin   6 ints, 4 chars, char* CoinName                      (40 bytes on x64)
 *   AcceptorBlock  7 ints, char Currency[4], AcceptorCoin Coin[256], int SerialNumber,
 *                  char* Description, int EscrowBarcodeHere                (10296 bytes)
 *   DispenserBlock 11 ints, char* Description                            (56 bytes)
 *   EscrowNoteDetails 6 ints; EscrowControlBlock 7 ints, int Reserved[16], EscrowNoteDetails[64]
 *   EventDetailBlock 4 ints
 *
 * The `char*` members are kept opaque (`void *`) so a Read → change → Write round trip hands the DLL
 * back exactly the pointers it gave; their text is decoded separately. Loaded only in the PayLink
 * utility process (paylinkWorker.ts) — a fault in the vendor's code never takes the app down.
 */

import { createRequire } from 'node:module';

/** The koffi surface used here (koffi ships its own types; kept minimal so the main bundle never imports it). */
interface Koffi {
  load(path: string): { func(proto: string): (...args: unknown[]) => unknown };
  struct(name: string, def: Record<string, unknown>): unknown;
  array(type: unknown, n: number, hint?: string): unknown;
  sizeof(type: unknown): number;
  decode(ptr: unknown, type: string, len?: number): unknown;
}

export interface CoinBlock {
  Value: number;
  Inhibit: number;
  Count: number;
  Path: number;
  PathCount: number;
  PathSwitchLevel: number;
  DefaultPath: number;
  FutureExpansion: number;
  HeldInEscrow: number;
  FutureExpansion2: number;
  CoinName: unknown;
}

export interface AcceptorBlockJs {
  Unit: number;
  Status: number;
  NoOfCoins: number;
  InterfaceNumber: number;
  UnitAddress: number;
  DefaultPath: number;
  BarcodesStacked: number;
  Currency: string | number[];
  Coin: CoinBlock[];
  SerialNumber: number;
  Description: unknown;
  EscrowBarcodeHere: number;
}

export interface DispenserBlockJs {
  Unit: number;
  Status: number;
  InterfaceNumber: number;
  UnitAddress: number;
  Value: number;
  Count: number;
  Inhibit: number;
  NotesToDump: number;
  CoinCount: number;
  CoinCountStatus: number;
  SerialNumber: number;
  Description: unknown;
}

export interface EscrowBlockJs {
  EscrowVersion: number;
  State: number;
  Result: number;
  TotalValue: number;
  ValueReturned: number;
  AcceptorNo: number;
  NoInEscrow: number;
  Reserved: number[];
  EscrowNote: Array<{ Value: number; NoteNumber: number; Location: number; Status: number; Reserved: number[] }>;
}

export interface EventBlockJs {
  EventCode: number;
  RawEvent: number;
  DispenserEvent: number;
  Index: number;
}

/** The DLL's functions, as this app calls them. */
export interface PaylinkLib {
  OpenMHEVersion(version: number): number;
  OpenSpecificMHEVersion(serial: string, version: number): number;
  EnableInterface(): void;
  DisableInterface(): void;
  CurrentValue(): number;
  CurrentPaid(): number;
  LastPayStatus(): number;
  CurrentUpdates(): number;
  PayOut(value: number): void;
  SetDispenseQuantity(index: number, quantity: number, value: number): number;
  PaySpecific(): number;
  IndicatorOn(n: number): void;
  IndicatorOff(n: number): void;
  SwitchOpens(n: number): number;
  SwitchCloses(n: number): number;
  ReadAcceptorDetails(n: number): AcceptorBlockJs | null;
  WriteAcceptorDetails(n: number, b: AcceptorBlockJs): void;
  ReadDispenserDetails(n: number): DispenserBlockJs | null;
  WriteDispenserDetails(n: number, b: DispenserBlockJs): void;
  EscrowEnable(): void;
  EscrowDisable(): void;
  EscrowAccept(): void;
  EscrowReturn(): void;
  EscrowThroughput(): number;
  ReadEscrowBlock(n: number): EscrowBlockJs | null;
  EscrowCommand(n: number, command: number): void;
  NextEvent(): EventBlockJs | null;
  CheckOperation(sequence: number, timeoutMs: number): number;
  SerialNumber(): number;
  FirmwareVersion(): number;
  USBDriverStatus(): number;
  USBDriverExit(): void;
  IMHEIConsistencyError(coinMs: number, noteMs: number): string | null;
  DESStatus(): number;
  /** A struct's char* member as text. */
  text(ptr: unknown): string;
}

export const STRUCT_SIZES = { AcceptorCoin: 40, AcceptorBlock: 10296, DispenserBlock: 56, EscrowNoteDetails: 24, EscrowControlBlock: 1628, EventDetailBlock: 16 } as const;

/** koffi, from the app's own node_modules (a native, Node-API module: no rebuild per Electron). */
export function loadKoffi(): Koffi {
  const req = createRequire(__filename);
  const name = 'koffi';
  return req(name) as Koffi;
}

export function defineStructs(koffi: Koffi) {
  const AcceptorCoin = koffi.struct('AcceptorCoin', {
    Value: 'int',
    Inhibit: 'int',
    Count: 'int',
    Path: 'int',
    PathCount: 'int',
    PathSwitchLevel: 'int',
    DefaultPath: 'char',
    FutureExpansion: 'char',
    HeldInEscrow: 'char',
    FutureExpansion2: 'char',
    CoinName: 'void *',
  });
  const AcceptorBlock = koffi.struct('AcceptorBlock', {
    Unit: 'int',
    Status: 'int',
    NoOfCoins: 'int',
    InterfaceNumber: 'int',
    UnitAddress: 'int',
    DefaultPath: 'int',
    BarcodesStacked: 'int',
    Currency: koffi.array('char', 4, 'Array'),
    Coin: koffi.array(AcceptorCoin, 256),
    SerialNumber: 'int',
    Description: 'void *',
    EscrowBarcodeHere: 'int',
  });
  const DispenserBlock = koffi.struct('DispenserBlock', {
    Unit: 'int',
    Status: 'int',
    InterfaceNumber: 'int',
    UnitAddress: 'int',
    Value: 'int',
    Count: 'int',
    Inhibit: 'int',
    NotesToDump: 'int',
    CoinCount: 'int',
    CoinCountStatus: 'int',
    SerialNumber: 'int',
    Description: 'void *',
  });
  const EscrowNoteDetails = koffi.struct('EscrowNoteDetails', { Value: 'int', NoteNumber: 'int', Location: 'int', Status: 'int', Reserved: koffi.array('int', 2) });
  const EscrowControlBlock = koffi.struct('EscrowControlBlock', {
    EscrowVersion: 'int',
    State: 'int',
    Result: 'int',
    TotalValue: 'int',
    ValueReturned: 'int',
    AcceptorNo: 'int',
    NoInEscrow: 'int',
    Reserved: koffi.array('int', 16),
    EscrowNote: koffi.array(EscrowNoteDetails, 64),
  });
  const EventDetailBlock = koffi.struct('EventDetailBlock', { EventCode: 'int', RawEvent: 'int', DispenserEvent: 'int', Index: 'int' });
  return { AcceptorCoin, AcceptorBlock, DispenserBlock, EscrowNoteDetails, EscrowControlBlock, EventDetailBlock };
}

/** The DLL bound. Throws when the file cannot be loaded (the host reports "דרייבר מזומן לא מותקן"). */
export function loadPaylinkLib(dllPath: string, koffi: Koffi = loadKoffi()): PaylinkLib {
  defineStructs(koffi);
  const lib = koffi.load(dllPath);
  // __stdcall is the header's convention; on x64 there is one calling convention.
  const f = (proto: string) => lib.func(proto);
  const OpenMHEVersion = f('int OpenMHEVersion(int)');
  const OpenSpecificMHEVersion = f('int OpenSpecificMHEVersion(const char *, int)');
  const EnableInterface = f('void EnableInterface()');
  const DisableInterface = f('void DisableInterface()');
  const CurrentValue = f('int CurrentValue()');
  const CurrentPaid = f('int CurrentPaid()');
  const LastPayStatus = f('int LastPayStatus()');
  const CurrentUpdates = f('int CurrentUpdates()');
  const PayOut = f('void PayOut(int)');
  const SetDispenseQuantity = f('int SetDispenseQuantity(int, int, int)');
  const PaySpecific = f('int PaySpecific()');
  const IndicatorOn = f('void IndicatorOn(int)');
  const IndicatorOff = f('void IndicatorOff(int)');
  const SwitchOpens = f('int SwitchOpens(int)');
  const SwitchCloses = f('int SwitchCloses(int)');
  const ReadAcceptorDetails = f('int ReadAcceptorDetails(int, _Out_ AcceptorBlock *)');
  const WriteAcceptorDetails = f('void WriteAcceptorDetails(int, AcceptorBlock *)');
  const ReadDispenserDetails = f('int ReadDispenserDetails(int, _Out_ DispenserBlock *)');
  const WriteDispenserDetails = f('void WriteDispenserDetails(int, DispenserBlock *)');
  const EscrowEnable = f('void EscrowEnable()');
  const EscrowDisable = f('void EscrowDisable()');
  const EscrowAccept = f('void EscrowAccept()');
  const EscrowReturn = f('void EscrowReturn()');
  const EscrowThroughput = f('int EscrowThroughput()');
  const ReadEscrowBlock = f('int ReadEscrowBlock(int, _Out_ EscrowControlBlock *)');
  const EscrowCommand = f('void EscrowCommand(int, int)');
  const NextEvent = f('int NextEvent(_Out_ EventDetailBlock *)');
  const CheckOperation = f('int CheckOperation(int, int)');
  const SerialNumber = f('int SerialNumber()');
  const FirmwareVersion = f('int FirmwareVersion(void *, void *)');
  const USBDriverStatus = f('int USBDriverStatus()');
  const USBDriverExit = f('void USBDriverExit()');
  const IMHEIConsistencyError = f('const char * IMHEIConsistencyError(int, int)');
  const DESStatus = f('int DESStatus()');
  const out = <T,>(fn: (...a: unknown[]) => unknown, ...args: unknown[]): T | null => {
    const o = {} as T;
    const r = fn(...args, o) as number;
    return r ? o : null;
  };
  return {
    OpenMHEVersion: (v) => OpenMHEVersion(v) as number,
    OpenSpecificMHEVersion: (s, v) => OpenSpecificMHEVersion(s, v) as number,
    EnableInterface: () => void EnableInterface(),
    DisableInterface: () => void DisableInterface(),
    CurrentValue: () => CurrentValue() as number,
    CurrentPaid: () => CurrentPaid() as number,
    LastPayStatus: () => LastPayStatus() as number,
    CurrentUpdates: () => CurrentUpdates() as number,
    PayOut: (v) => void PayOut(v),
    SetDispenseQuantity: (i, q, v) => SetDispenseQuantity(i, q, v) as number,
    PaySpecific: () => PaySpecific() as number,
    IndicatorOn: (n) => void IndicatorOn(n),
    IndicatorOff: (n) => void IndicatorOff(n),
    SwitchOpens: (n) => SwitchOpens(n) as number,
    SwitchCloses: (n) => SwitchCloses(n) as number,
    ReadAcceptorDetails: (n) => out<AcceptorBlockJs>(ReadAcceptorDetails, n),
    WriteAcceptorDetails: (n, b) => void WriteAcceptorDetails(n, b),
    ReadDispenserDetails: (n) => out<DispenserBlockJs>(ReadDispenserDetails, n),
    WriteDispenserDetails: (n, b) => void WriteDispenserDetails(n, b),
    EscrowEnable: () => void EscrowEnable(),
    EscrowDisable: () => void EscrowDisable(),
    EscrowAccept: () => void EscrowAccept(),
    EscrowReturn: () => void EscrowReturn(),
    EscrowThroughput: () => EscrowThroughput() as number,
    ReadEscrowBlock: (n) => out<EscrowBlockJs>(ReadEscrowBlock, n),
    EscrowCommand: (n, c) => void EscrowCommand(n, c),
    NextEvent: () => {
      const o = {} as EventBlockJs;
      const code = NextEvent(o) as number;
      return code ? { ...o, EventCode: code } : null;
    },
    CheckOperation: (s, t) => CheckOperation(s, t) as number,
    SerialNumber: () => SerialNumber() as number,
    FirmwareVersion: () => FirmwareVersion(null, null) as number,
    USBDriverStatus: () => USBDriverStatus() as number,
    USBDriverExit: () => void USBDriverExit(),
    IMHEIConsistencyError: (c, n) => (IMHEIConsistencyError(c, n) as string | null) ?? null,
    DESStatus: () => DESStatus() as number,
    text: (ptr) => {
      if (!ptr) return '';
      try {
        return String(koffi.decode(ptr, 'char', -1) ?? '');
      } catch {
        return '';
      }
    },
  };
}
