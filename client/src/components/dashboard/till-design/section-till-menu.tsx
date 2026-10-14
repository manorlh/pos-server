'use client';

/**
 * "תפריט הקופה" in "עיצוב קופה" (P:/specs/till-menu-hide.md): the till's menu items hidden at the level
 * being edited — company, shop, point of sale or a single till — for everyone, whatever their
 * permissions. The till parameter `hiddenMenuItems`, not part of the design's layer: saved here at once
 * (`PUT /till-design/menu-hide`), the same value the parameters page and the device page edit, each
 * change in the parameters' log. Written by a company manager and up only (the owner, 14.10): a shop
 * manager, who edits the rest of the design, sees this card read-only.
 */

import { TillMenuLevelEditor } from '@/components/dashboard/till-menu/till-menu-level-editor';
import { useTillEditor } from './editor-context';
import { SectionCard } from './fields';

export function TillMenuSection() {
  const ed = useTillEditor();
  return (
    <SectionCard
      title="תפריט הקופה"
      description="פריטים שלא יוצגו בתפריט הקופה ברמה הזו, לאף עובד, גם לא למנהל, בלי קשר להרשאות. נשמר מיד, בנפרד מהעיצוב."
    >
      <TillMenuLevelEditor route="design" level={ed.level} id={ed.targetId} editable={ed.canEdit} />
    </SectionCard>
  );
}
