import { redirect } from 'next/navigation';

export default function Home() {
  // Through the landing route: it sends the user to their opening page ("דף פתיחה").
  redirect('/dashboard/start');
}
