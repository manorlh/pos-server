/**
 * "מכשירי תשלום" — pos-server app/routers/payment_devices.py. The rules and shapes are in
 * lib/paymentDevices.ts.
 */
import { api } from './api';
import type { MachinePaymentDevices, PaymentDevice, PaymentDeviceInput, ShopPaymentDevices } from './paymentDevices';

export const shopPaymentDevicesKey = (shopId: string) => ['payment-devices', 'shop', shopId] as const;
export const machinePaymentDevicesKey = (machineId: string) => ['payment-devices', 'machine', machineId] as const;

export async function fetchShopPaymentDevices(shopId: string): Promise<ShopPaymentDevices> {
  const { data } = await api.get<ShopPaymentDevices>(`/shops/${shopId}/payment-devices`);
  return data;
}

export async function fetchMachinePaymentDevices(machineId: string): Promise<MachinePaymentDevices> {
  const { data } = await api.get<MachinePaymentDevices>(`/machines/${machineId}/payment-devices`);
  return data;
}

export async function createPaymentDevice(shopId: string, body: PaymentDeviceInput): Promise<PaymentDevice> {
  const { data } = await api.post<PaymentDevice>(`/shops/${shopId}/payment-devices`, body);
  return data;
}

export async function updatePaymentDevice(id: string, body: PaymentDeviceInput): Promise<PaymentDevice> {
  const { data } = await api.put<PaymentDevice>(`/payment-devices/${id}`, body);
  return data;
}

export async function deletePaymentDevice(id: string): Promise<void> {
  await api.delete(`/payment-devices/${id}`);
}
