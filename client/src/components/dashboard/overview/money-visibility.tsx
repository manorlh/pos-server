'use client';

/**
 * Whether the tills tree and a till's details show money. The control board shows the
 * tills' state to everyone signed in; a user without "דוחות" sees the state (online, shift,
 * alerts, versions) and not the takings — the board leaves them out through this context.
 */

import { createContext, useContext } from 'react';

const ShowMoneyContext = createContext(true);

export const ShowMoneyProvider = ShowMoneyContext.Provider;

export function useShowMoney(): boolean {
  return useContext(ShowMoneyContext);
}
