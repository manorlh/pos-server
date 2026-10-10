/**
 * Server-safe half of lib/theme: the storage key, and the inline script the root layout runs
 * before the first paint so a saved dark choice never flashes light.
 */

export const THEME_KEY = 'pos-theme';

export const THEME_INIT_SCRIPT = `try{if(localStorage.getItem('${THEME_KEY}')==='dark'){var r=document.documentElement;r.classList.add('dark');r.style.colorScheme='dark'}}catch(e){}`;
