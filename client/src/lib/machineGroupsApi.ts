/**
 * "קבוצות מכשירים" on the wire (pos-server app/routers/machine_groups.py). The rules are
 * lib/machineGroups.ts.
 */
import { api } from './api';
import type { MachineGroup } from './machineGroups';

export const MACHINE_GROUPS_KEY = ['machine-groups'] as const;

/** The groups the user sees (`companyId`: that company and those beneath it), with their tills. */
export async function fetchMachineGroups(companyId?: string | null): Promise<MachineGroup[]> {
  return (await api.get<MachineGroup[]>('/machine-groups', { params: companyId ? { companyId } : {} })).data;
}

export async function createMachineGroup(body: {
  name: string;
  companyId: string;
  machineIds: string[];
}): Promise<MachineGroup> {
  return (await api.post<MachineGroup>('/machine-groups', body)).data;
}

export async function renameMachineGroup(id: string, name: string): Promise<MachineGroup> {
  return (await api.patch<MachineGroup>(`/machine-groups/${id}`, { name })).data;
}

/** The members replaced. */
export async function setMachineGroupTills(id: string, machineIds: string[]): Promise<MachineGroup> {
  return (await api.put<MachineGroup>(`/machine-groups/${id}/machines`, { machineIds })).data;
}

/** The group, its members and the menus assigned to it. */
export async function deleteMachineGroup(id: string): Promise<void> {
  await api.delete(`/machine-groups/${id}`);
}
