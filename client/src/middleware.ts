import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

// `/k`: the browser kiosk (docs/SPEC_KIOSK.md §27); `/kds`, `/board`: the browser KDS and "מוכן / לא מוכן"
// board (docs/SPEC_KDS.md §13) — each device signs in with its machine token, never Clerk.
const isPublicRoute = createRouteMatcher(['/sign-in(.*)', '/sign-up(.*)', '/mobile/pair(.*)', '/join(.*)', '/k', '/k/(.*)', '/kds', '/kds/(.*)', '/board', '/board/(.*)', '/display', '/display/(.*)']);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|png|webp|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
