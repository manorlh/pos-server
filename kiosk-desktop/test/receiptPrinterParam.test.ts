/**
 * "מדפסת חשבוניות — כתובת" (till parameter `receiptPrinterAddress`) as the Windows app reads it: an IP[:port] is a network printer;
 * a Windows printer's NAME is that queue (the Windows till has no technician corner to choose one); a Bluetooth MAC or nothing is
 * the automatic choice (the USB printer plugged in, else a queue guessed by name).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { harness, type Harness } from './tillEngineHarness';

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.stop();
});
const printerFor = (address: unknown) => {
  const h = harness({ parameters: address === undefined ? {} : { receiptPrinterAddress: address } });
  open.push(h);
  return h.svc.localSettings().printer;
};

describe('the receipt printer from the cloud', () => {
  it('an IP address (with or without a port) is a network printer', () => {
    expect(printerFor('192.168.0.50')).toEqual({ transport: 'tcp', host: '192.168.0.50', port: 9100 });
    expect(printerFor('192.168.0.50:9101')).toEqual({ transport: 'tcp', host: '192.168.0.50', port: 9101 });
  });

  it('a Windows printer name is that queue', () => {
    expect(printerFor('  SNBC BTP-S80  ')).toEqual({ transport: 'spooler', queueName: 'SNBC BTP-S80' });
  });

  it('nothing, or a Bluetooth MAC, is the automatic choice', () => {
    expect(printerFor(undefined)).toEqual({ transport: 'spooler', queueName: null });
    expect(printerFor('')).toEqual({ transport: 'spooler', queueName: null });
    expect(printerFor('AA:BB:CC:DD:EE:FF')).toEqual({ transport: 'spooler', queueName: null });
  });
});
