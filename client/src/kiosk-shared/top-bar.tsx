/**
 * "סרגל עליון" (layout.topBar, P:/specs/kiosk-rail-motion.md §6.1) on both TypeScript kiosk hosts — the Windows
 * kiosk's renderer/kiosk/KioskApp.tsx and the browser kiosk's components/kiosk-web/web-kiosk-app.tsx — as the Android
 * kiosk's KioskTopBar: the club, search and language buttons with something to do, so a real kiosk shows them all
 * (the shared TopBar shows a real kiosk's button only with its action):
 *
 *  - club: the club's window (ClubWindow — the attract screen's club card, where a voucher pays the note where it is
 *    entered), "הבנתי" closes it;
 *  - search: the field under the bar and the kiosk's keyboard at once; the menu shows the matching dishes in every
 *    layout (searchedModel); the bar's ✕ closes it;
 *  - language: the kiosk's languages (general.languages) in turn; the host draws its texts in `lang` and the screens
 *    in `dir`. Back at rest: the kiosk's own language, no search, no window.
 *
 * The rules are lib/kioskTopBar.ts (pure); a host calls the hook, spreads `live` into its KioskLive and draws
 * <KioskTopBarWindows> over its screens.
 */

import { useState } from 'react';
import type { KioskConfig } from '@/lib/kioskConfig';
import { kioskLanguages, languageDir, nextLanguage, topBarReduce, HOME_LANGUAGE, TOP_BAR_SEARCH_MAX, TOP_BAR_START, type KioskTopBarEvent, type KioskTopBarState } from '@/lib/kioskTopBar';
import { ClubWindow, type KioskLive, type PreviewModel } from '@/components/dashboard/kiosks/preview-screens';
import { EntryWindow } from '@/components/dashboard/kiosks/preview-entry';
import { ReachSheets } from './layouts/reach';
import { kt } from './layouts/parts';

export interface KioskTopBarHost {
  state: KioskTopBarState;
  /** The language the screens' texts are drawn in now (the kiosk's own until the customer switches). */
  lang: string;
  /** The screens' direction in that language. */
  dir: 'rtl' | 'ltr';
  /** What the shared TopBar and CatalogHeader do on this kiosk (KioskLive's topBar and search). */
  live: Pick<KioskLive, 'topBar' | 'search'>;
  send: (e: KioskTopBarEvent) => void;
}

/**
 * The top bar's state for a host: `screen` the flow's screen, `resting` whether it is a rest screen (attract,
 * paused…). A screen change closes the windows; rest brings everything back as at the start.
 */
export function useKioskTopBar(cfg: Pick<KioskConfig, 'general'>, screen: string, resting: boolean): KioskTopBarHost {
  const [state, setState] = useState<KioskTopBarState>(TOP_BAR_START);
  const [seen, setSeen] = useState(screen);
  if (seen !== screen) {
    setSeen(screen);
    setState((s) => topBarReduce(s, { type: 'screen', resting }));
  }
  return topBarHost(cfg, state, (e) => setState((s) => topBarReduce(s, e)));
}

/** What a host gets for the top bar in `state` (the hook's, without React): its buttons' actions, the search, the language. */
export function topBarHost(cfg: Pick<KioskConfig, 'general'>, state: KioskTopBarState, send: (e: KioskTopBarEvent) => void): KioskTopBarHost {
  const languages = kioskLanguages(cfg);
  const lang = state.lang ?? HOME_LANGUAGE;
  return {
    state,
    lang,
    dir: languageDir(lang),
    live: {
      topBar: {
        club: () => send({ type: 'club' }),
        search: () => send({ type: 'search' }),
        lang: () => send({ type: 'lang', languages }),
        nextLang: nextLanguage(languages, lang),
      },
      search: state.searchOpen ? { query: state.query, onEdit: () => send({ type: 'edit' }), onClear: () => send({ type: 'clear' }) } : undefined,
    },
    send,
  };
}

/** The top bar's windows over a host's screens: the club's window and the search's keyboard (the menu's only). */
export function KioskTopBarWindows({ m, bar, screen }: { m: PreviewModel; bar: KioskTopBarHost; screen: string }) {
  if (screen !== 'catalog') return null;
  const { clubOpen, typing, query } = bar.state;
  return (
    <>
      {clubOpen ? (
        <ReachSheets m={m}>
          <ClubWindow m={m} onClose={() => bar.send({ type: 'clubClose' })} />
        </ReachSheets>
      ) : null}
      {typing ? (
        <EntryWindow
          m={m}
          caption={kt(m, 'searchTitle')}
          steps={[
            {
              key: 'q',
              icon: 'search',
              title: kt(m, 'searchTitle'),
              hint: kt(m, 'searchHint'),
              initial: query,
              max: TOP_BAR_SEARCH_MAX,
              confirmLabel: kt(m, 'searchTitle'),
              commit: () => undefined,
            },
          ]}
          onFinish={(given) => bar.send({ type: 'typed', query: given.q ?? '' })}
          onClose={() => bar.send({ type: 'typingClose' })}
        />
      ) : null}
    </>
  );
}
