import { getRequestConfig } from 'next-intl/server';

export default getRequestConfig(async () => {
  return {
    locale: 'he',
    messages: (await import('@/messages/he.json')).default,
  };
});
