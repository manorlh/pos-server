/**
 * "מסך מטבח (KDS)" on Windows — the shared kitchen screen (client/src/kiosk-shared/roles/kds: the
 * browser KDS at `/kds` draws the very same) on the shell's bridge (`window.r2m`, main/roles/kds.ts),
 * with the technician's corner (six taps top-left). Not a till.
 */

import { KdsScreen as SharedKdsScreen } from '@kiosk-shared/roles/kds/KdsScreen';
import type { ShellView } from '../../../shared/roles';
import { shell } from '../shellBridge';
import { RoleTechnician, useTechnicianCorner } from '../RoleTechnician';

export function KdsScreen({ shellView }: { shellView: ShellView }) {
  const [tech, setTech, onCorner] = useTechnicianCorner();
  return (
    <SharedKdsScreen
      bridge={shell}
      machineName={shellView.machineName}
      shopName={shellView.shopName}
      onPointerDown={onCorner}
      overlay={tech ? <RoleTechnician shellView={shellView} onClose={() => setTech(false)} /> : null}
    />
  );
}
