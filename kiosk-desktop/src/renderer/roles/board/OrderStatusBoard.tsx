/**
 * "מסך מוכן / לא מוכן" on Windows — the shared order status board (client/src/kiosk-shared/roles/
 * board: the browser board at `/board` draws the very same, with the look set on the dashboard's KDS
 * page) on the shell's bridge (main/roles/board.ts), with the technician's corner. Not a till.
 */

import { OrderStatusBoard as SharedBoard } from '@kiosk-shared/roles/board/OrderStatusBoard';
import type { ShellView } from '../../../shared/roles';
import { shell } from '../shellBridge';
import { RoleTechnician, useTechnicianCorner } from '../RoleTechnician';

export function OrderStatusBoard({ shellView }: { shellView: ShellView }) {
  const [tech, setTech, onCorner] = useTechnicianCorner();
  return (
    <SharedBoard
      bridge={shell}
      shopName={shellView.shopName}
      onPointerDown={onCorner}
      overlay={tech ? <RoleTechnician shellView={shellView} onClose={() => setTech(false)} /> : null}
    />
  );
}
