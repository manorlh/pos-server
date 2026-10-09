import { SignUp } from '@clerk/nextjs';
import { PoweredBy } from '@/components/powered-by';

export default function SignUpPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-muted/40">
      <SignUp
        routing="path"
        path="/sign-up"
        signInUrl="/sign-in"
        fallbackRedirectUrl="/dashboard/start"
      />
      <PoweredBy />
    </div>
  );
}
